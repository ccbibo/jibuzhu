// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildAttribution } from '../lib/attribution.ts';
import { createApplication } from '../standalone/server.mjs';

// Independent synthetic acceptance cases. No network, real identities, or provider credentials.
const meeting={title:'獨立認領反例',meetingDate:'2026-10-31',mode:'rules',transcript:'A：預算由小林追蹤\nA：另一段仍不可自動認領\nB：我是小林\n沒有標記的任意段落'};
const participants=[{id:'p1',name:'小林'},{id:'p2',name:'小林'}];
const build=(events=[],m=meeting,p=participants)=>buildAttribution(m,p,events);
const event=(id,actorId,action,...segmentIds)=>({id,actorId,action,segmentIds});
async function ids(){return (await build()).segments.map(s=>s.id);}
function state(result,index,status,person=null){assert.equal(result.segments[index].status,status);assert.equal(result.segments[index].person?.id??null,person);}

test('independent: source labels and self-introduction never establish identity',async()=>{
  const r=await build();assert.equal(r.provenance,'demo');assert.equal(r.segments.length,4);
  assert.equal(r.segments[0].sourceLabel,'A');assert.equal(r.segments[2].sourceLabel,'B');
  for(let i=0;i<4;i++)state(r,i,'unclaimed');
  const plain=await build([],{...meeting,transcript:'這段沒有身分標記，也只是提到小林。'});
  assert.equal(plain.segments[0].sourceLabel,null);state(plain,0,'unclaimed');
});
test('independent: claim is pending until own confirmation; same A does not propagate',async()=>{
  const [s]=await ids();const claimed=await build([event('c','p1','claim',s)]);
  state(claimed,0,'pending');state(claimed,1,'unclaimed');
  const confirmed=await build([event('c','p1','claim',s),event('ok','p1','confirm',s)]);
  state(confirmed,0,'confirmed','p1');state(confirmed,1,'unclaimed');
  const again=await build([event('c','p1','claim',s),event('ok','p1','confirm',s),event('repeat','p1','claim',s)]);
  state(again,0,'confirmed','p1');
  const foreign=await build([event('c','p1','claim',s),event('ok','p1','confirm',s),event('not-yours','p2','retract',s)]);
  state(foreign,0,'confirmed','p1');
  assert.equal(foreign.audit.at(-1).outcome,'ignored');
});
test('independent: confirmation without a claim or another person confirmation cannot assert identity',async()=>{
  const [s]=await ids();const r=await build([event('bad','p2','confirm',s),event('c','p1','claim',s),event('other','p2','confirm',s)]);
  state(r,0,'pending');assert.ok(r.audit.length>=3);
});
test('independent: same-name IDs remain separate, dispute clears confirmation, withdrawal requires reconfirmation',async()=>{
  const [s]=await ids();const prefix=[event('c1','p1','claim',s),event('ok1','p1','confirm',s),event('c2','p2','claim',s)];
  const dispute=await build(prefix);state(dispute,0,'disputed');assert.deepEqual(new Set(dispute.segments[0].claimants.map(p=>p.id)),new Set(['p1','p2']));
  state(await build([...prefix,event('force','p2','confirm',s)]),0,'disputed');
  const retract=[...prefix,event('r','p2','retract',s)];state(await build(retract),0,'pending');
  state(await build([...retract,event('ok2','p1','confirm',s)]),0,'confirmed','p1');
  state(await build([...retract,event('ok2','p1','confirm',s),event('r1','p1','retract',s)]),0,'unclaimed');
});
test('independent: source changes invalidate old segment claims including unchanged lines in a changed meeting',async()=>{
  const [s]=await ids();const events=[event('c','p1','claim',s),event('ok','p1','confirm',s)];
  for(const m of [{...meeting,meetingDate:'2026-10-30'},{...meeting,transcript:meeting.transcript+'\n新增行'},{...meeting,transcript:meeting.transcript.replace('預算','經費')}])await assert.rejects(()=>build(events,m));
});
test('independent: explicit multisegment selection works without selecting other source-label peers',async()=>{
  const [a,,b]=await ids();const r=await build([event('c','p1','claim',a,b),event('ok','p1','confirm',a,b)]);
  state(r,0,'confirmed','p1');state(r,1,'unclaimed');state(r,2,'confirmed','p1');
});
test('independent: malformed participants and duplicate IDs reject; equal names are legal',async()=>{
  for(const p of [null,{},[null],[{id:'',name:'x'}],[{id:'x',name:''}],[{id:'x',name:'x'},{id:'x',name:'y'}],[{id:4,name:'x'}],[{id:'x',name:'x'.repeat(81)}],Array.from({length:51},(_,i)=>({id:String(i),name:'x'}))])await assert.rejects(()=>build([],meeting,p));
  assert.equal((await build()).segments.length,4);
});
test('independent: malformed events, duplicate event/segment IDs, unknown actors and stale targets reject atomically',async()=>{
  const [s]=await ids();const good=event('valid','p1','claim',s);
  const bad=[null,{},event('bad','missing','claim',s),event('bad','p1','overwrite',s),event('bad','p1','claim'),event('bad','p1','claim',s,s),event('bad','p1','claim',s,'stale'),event('x'.repeat(161),'p1','claim',s),{...good,id:''},{...good,segmentIds:'not-an-array'},...[]];
  for(const invalid of bad)await assert.rejects(()=>build([good,invalid]));
  await assert.rejects(()=>build([good,{...good}]));await assert.rejects(()=>build(Array.from({length:501},(_,i)=>event('e'+i,'p1','claim',s))));
  await assert.rejects(()=>build([event('too-many','p1','claim',...Array.from({length:101},(_,i)=>'id'+i))]));
  // A rejected replay cannot mutate a later clean result.
  state(await build(),0,'unclaimed');
});

async function fixture(t,config={model:'test-only'},provider){
  let calls=0;const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config,fetcher:async(...args)=>{calls++;if(provider)return provider(...args);throw Error('Provider forbidden in independent local guard tests');}});
  app.address=()=>({port:4173});t.after(()=>app.emit('close'));
  const dispatch=(url,headers={},body)=>new Promise(resolve=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(body)]);req.url=url;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173',...headers};
    const res={headersSent:false,writeHead(status,h){this.status=status;this.headers=h;this.headersSent=true;},end(body){resolve({status:this.status,headers:this.headers,body});}};app.emit('request',req,res);
  });
  const home=await dispatch('/');assert.equal(home.status,200);const cookie=home.headers['Set-Cookie'].split(';')[0];
  const headers={cookie,origin:'http://127.0.0.1:4173','content-type':'application/json'};
  const post=(route,body,extra={})=>dispatch(route,{...headers,...extra},JSON.stringify(body));
  return {dispatch,headers,post,calls:()=>calls};
}
test('independent: actual attribution handlers enforce session, origin, JSON and body bounds',async t=>{
  const f=await fixture(t);const body=JSON.stringify({meeting,participants,events:[]});
  for(const route of ['/api/attribution/demo','/api/attribution/notion']){
    assert.equal((await f.dispatch(route,{},body)).status,401);
    assert.equal((await f.dispatch(route,{...f.headers,origin:'https://evil.test'},body)).status,403);
    assert.equal((await f.dispatch(route,{...f.headers,'sec-fetch-site':'cross-site'},body)).status,403);
    assert.equal((await f.dispatch(route,{...f.headers,'content-type':'text/plain'},body)).status,415);
    assert.equal((await f.dispatch(route,f.headers,'{')).status,400);
    assert.equal((await f.dispatch(route,f.headers,'x'.repeat(160001))).status,400);
  }assert.equal(f.calls(),0);
});
test('independent: demo provenance cannot be spoofed; invalid replay has no partial result',async t=>{
  const f=await fixture(t);const [s]=await ids();
  const response=await f.post('/api/attribution/demo',{meeting,participants,events:[event('c','p1','claim',s),event('ok','p1','confirm',s)],provenance:'notion'});
  assert.equal(response.status,200,response.body);const result=JSON.parse(response.body);assert.equal(result.provenance,'demo');state(result,0,'confirmed','p1');
  const bad=await f.post('/api/attribution/demo',{meeting,participants,events:[event('c','p1','claim',s),event('bad','p1','claim','stale')]});
  assert.equal(bad.status,400);assert.equal(JSON.parse(bad.body).segments,undefined);assert.equal(f.calls(),0);
});
test('independent: unconfigured Notion returns 503 without trusting supplied actor or contacting provider',async t=>{
  const f=await fixture(t);const [s]=await ids();const response=await f.post('/api/attribution/notion',{meeting,actorId:'victim',participants,events:[event('c','p1','claim',s),event('ok','p1','confirm',s)],provenance:'notion'});
  assert.equal(response.status,503,response.body);assert.equal(JSON.parse(response.body).segments,undefined);assert.equal(f.calls(),0);
});

// DOM contract harness executes the actual UI script; this is not a browser layout test.
function uiFixture(fetcher=async()=>{throw Error('Unexpected fetch');}){
  class Element {
    constructor(tag='div',text=''){this.tagName=tag;this.textContent=text;this.children=[];this.value='';this.dataset={};this.listeners={};this.hidden=false;this.disabled=false;this.attrs={};}
    get childNodes(){return this.children;}
    append(...items){for(const item of items)this.insertBefore(item,null);}
    insertBefore(item,reference){
      if(reference!==null&&!this.children.includes(reference))throw Error('Reference is not a child');
      if(item===reference)return item;
      if(item.parentNode)item.parentNode.removeChild(item);
      const index=reference===null?this.children.length:this.children.indexOf(reference);
      this.children.splice(index,0,item);item.parentNode=this;return item;
    }
    removeChild(item){const index=this.children.indexOf(item);if(index<0)throw Error('Node is not a child');this.children.splice(index,1);item.parentNode=null;return item;}
    replaceChildren(...items){for(const child of [...this.children])this.removeChild(child);this.append(...items);}
    contains(item){return this===item||this.children.some(child=>child.contains(item));}
    querySelectorAll(selector){const tags=selector.split(',');return this.children.flatMap(child=>[...(tags.includes(child.tagName)?[child]:[]),...child.querySelectorAll(selector)]);}
    get isConnected(){return [...elements.values()].some(root=>root!==this&&root.contains(this));}
    focus(){document.activeElement=this;}

    setAttribute(k,v){this.attrs[k]=v;}
    getAttribute(k){return this.attrs[k]??null;}
    addEventListener(k,fn){this.listeners[k]=fn;}
    checkValidity(){return true;}
    set innerHTML(_){throw Error('Untrusted HTML sink used');}
  }
  const html=readFileSync(new URL('../standalone/attribution.html',import.meta.url),'utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  for(const [key,value] of Object.entries({'meeting-title':'UI synthetic','meeting-date':'2026-10-31','meeting-mode':'rules',transcript:'A：UI source','demo-actor':'demo-pinyu'}))elements.get(key).value=value;
  const document={listeners:{},addEventListener(type,handler){this.listeners[type]=handler;},getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text),querySelectorAll:()=>[],activeElement:null,body:new Element('body')};
  const context=vm.createContext({document,Option:function(text,value){const n=new Element('option',text);n.value=value;return n;},AbortController,fetch:fetcher,Set,Map,Date,crypto,console,navigator:{},Blob,URL,setTimeout:(fn,delay)=>{const timer=setTimeout(fn,delay);timer.unref?.();return timer;},clearTimeout});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1]+`;globalThis.ui={request,invalidate,render,renderPeople,setMode,getData:()=>data,getEvents:()=>events,setData:x=>{data=x},setEvents:x=>{events=x},getProvenance:()=>provenance};`,context);
  return {ui:context.ui,elements,context};
}
function uiText(node){return node.textContent+' '+node.children.map(uiText).join(' ');}
test('independent UI script: only confirmed person IDs enter query; same names remain distinct and text is safe',()=>{
  const f=uiFixture(),malicious='<img src=x onerror=alert(1)>',rows=[
    {id:'s1',lineIndex:0,text:malicious,sourceLabel:'A',status:'confirmed',person:{id:'one',name:'同名'},claimants:[],hints:[]},
    {id:'s2',lineIndex:1,text:'second',sourceLabel:'A',status:'confirmed',person:{id:'two',name:'同名'},claimants:[],hints:[]},
    {id:'s3',lineIndex:2,text:'pending',sourceLabel:'A',status:'pending',person:null,claimants:[{id:'one',name:'同名'}],hints:[]},
    {id:'s4',lineIndex:3,text:'disputed',sourceLabel:'A',status:'disputed',person:null,claimants:[{id:'one',name:'同名'},{id:'two',name:'同名'}],hints:[]}];
  f.ui.setData({segments:rows});f.ui.renderPeople();
  assert.deepEqual(f.elements.get('person-filter').children.slice(1).map(n=>n.textContent),['同名 · one','同名 · two']);
  f.elements.get('person-filter').value='one';f.ui.render();
  assert.equal(f.elements.get('segments').children.length,1);assert.ok(uiText(f.elements.get('segments')).includes(malicious));
  assert.ok(uiText(f.elements.get('segments')).includes('原文標記'));assert.ok(uiText(f.elements.get('segments')).includes('確認歸屬'));
  f.elements.get('person-filter').value='';f.ui.render();assert.equal(f.elements.get('segments').children.length,4);
  assert.ok(uiText(f.elements.get('segments')).includes('多人認領'));
});
test('independent UI script: source edit clears old events/query/data and discards a late response',async()=>{
  let complete;const f=uiFixture(()=>new Promise(resolve=>{complete=resolve;}));
  f.ui.setEvents([{id:'old-event'}]);f.elements.get('literal-query').value='old-query';
  const pending=f.ui.request();f.elements.get('transcript').value='new source';f.elements.get('transcript').listeners.input();
  assert.equal(f.ui.getData(),null);assert.equal(f.ui.getEvents().length,0);assert.equal(f.elements.get('literal-query').value,'');
  complete({ok:true,json:async()=>({meetingId:'old-version',provenance:'demo',segments:[],notice:'stale'})});await pending;
  assert.equal(f.ui.getData(),null);assert.equal(f.elements.get('export').disabled,true);
});
test('independent UI script: Notion request contains only meeting and displays provider warnings safely',async()=>{
  let captured;const f=uiFixture(async(url,options)=>{captured={url,body:JSON.parse(options.body)};return {ok:true,json:async()=>({meetingId:'v1',provenance:'notion',segments:[],audit:[],notice:'synthetic notice',warnings:['<script>stale command</script>']})};});
  f.ui.setMode('notion');await f.ui.request();
  assert.equal(captured.url,'/api/attribution/notion');assert.deepEqual(Object.keys(captured.body),['meeting']);
  assert.ok(f.elements.get('status').textContent.includes('<script>stale command</script>'));assert.equal(f.ui.getProvenance(),'notion');
});

test('independent configured Notion handler: author from created_by and user endpoint, ignores request actor/events/free name',async t=>{
  const [s]=await ids(),page='0123456789abcdef0123456789abcdef',author='server-comment-author';
  const comments=['claim','confirm'].map((action,i)=>({object:'comment',id:'comment-'+i,parent:{type:'page_id',page_id:page},created_by:{id:author,name:'forged free comment name'},last_edited_time:'2026-10-31T00:00:0'+i+'.000Z',rich_text:[{type:'text',text:{content:'記補住 '+action+' '+s}}]}));
  const urls=[];const f=await fixture(t,{model:'test-only',notionToken:'mock-only',claimPageId:page},async url=>{
    urls.push(String(url));
    if(String(url).includes('/comments?'))return Response.json({results:comments,has_more:false,next_cursor:null});
    assert.ok(String(url).endsWith('/users/'+author));return Response.json({object:'user',id:author,type:'person',name:'Server User Name'});
  });
  const response=await f.post('/api/attribution/notion',{meeting,actorId:'victim',participants:[{id:'victim',name:'forged'}],events:[event('forged','victim','claim',s)]});
  assert.equal(response.status,200,response.body);const result=JSON.parse(response.body);assert.equal(result.provenance,'notion');
  assert.deepEqual(result.segments[0].claimants,[{id:author,name:'Server User Name'}]);assert.equal(result.segments[0].person,null);
  assert.equal(result.audit.some(a=>a.actorId==='victim'),false);assert.ok(urls.some(u=>u.endsWith('/users/'+author)));
});

test('independent origin metadata: explicit, continuation and none distinguish source declarations without asserting identity',async()=>{
  const transcript=['沒有標記的前言','A：第一段','沿用A的文字','','[09:01] A：第二個明確標記','09:02 無括號時鐘仍是延續','B: explicit colon','沿用B文字'].join('\r\n');
  const result=await build([],{...meeting,transcript});
  assert.deepEqual(result.segments.map(s=>[s.lineIndex,s.sourceLabel,s.sourceLabelOrigin]),[
    [0,null,'none'],[1,'A','explicit'],[2,'A','continuation'],[4,'A','explicit'],[5,'A','continuation'],[6,'B','explicit'],[7,'B','continuation'],
  ]);
  assert.deepEqual(result.segments.map(s=>s.text),transcript.split('\r\n').filter(s=>s.trim()));
  for(let i=0;i<result.segments.length;i++)state(result,i,'unclaimed');
  const plain=await build([],{...meeting,transcript:'只有無標記文字\n後續仍無標記'});
  assert.deepEqual(plain.segments.map(s=>s.sourceLabelOrigin),['none','none']);
});

function uiNodes(root){return [root,...root.children.flatMap(uiNodes)];}
test('independent UI batch preview: selects only explicit same-label rows without sending or changing claims',()=>{
  let sent=0;const f=uiFixture(async()=>{sent++;throw Error('Preview must not send a request');});
  const rows=[
    {id:'a-explicit-1',sourceLabel:'A',sourceLabelOrigin:'explicit',status:'confirmed',person:{id:'one',name:'已確認者'}},
    {id:'a-continuation',sourceLabel:'A',sourceLabelOrigin:'continuation',status:'pending',person:null},
    {id:'a-explicit-2',sourceLabel:'A',sourceLabelOrigin:'explicit',status:'unclaimed',person:null},
    {id:'b-explicit',sourceLabel:'B',sourceLabelOrigin:'explicit',status:'unclaimed',person:null},
    {id:'no-label',sourceLabel:null,sourceLabelOrigin:'none',status:'unclaimed',person:null},
  ].map((s,i)=>({...s,lineIndex:i,text:s.id,claimants:s.person?[s.person]:[],hints:[]}));
  const data={segments:rows,provenance:'demo',meetingId:'synthetic-preview',audit:[]},before=JSON.stringify(data),events=[{id:'existing-event'}];
  f.ui.setData(data);f.ui.setEvents(events);f.ui.render();
  const previews=uiNodes(f.elements.get('segments')).filter(n=>n.tagName==='button'&&n.textContent.startsWith('預覽選取同標記'));
  assert.equal(previews.length,2);assert.ok(previews.every(n=>n.textContent.includes('2 段')));
  previews[0].onclick();
  const selectedArticles=f.elements.get('segments').children.filter(article=>uiNodes(article).some(n=>n.tagName==='input'&&n.checked));
  assert.deepEqual(selectedArticles.map(article=>uiNodes(article).find(n=>n.className==='segment-text').textContent),['a-explicit-1','a-explicit-2']);
  assert.equal(sent,0);assert.equal(JSON.stringify(f.ui.getData()),before);assert.equal(f.ui.getEvents(),events);
  assert.ok(f.elements.get('copy-status').textContent.includes('尚未認領'));assert.ok(f.elements.get('copy-status').textContent.includes('逐段核對'));
});
