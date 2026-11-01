// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildAttribution } from '../lib/attribution.ts';
import { createApplication } from '../standalone/server.mjs';

// Independent collaboration acceptance: recommendations never constitute self-claims.
const meeting={title:'人物浮卡獨立反例',meetingDate:'2026-10-31',mode:'rules',transcript:'A：第一段原話\n延伸原話\nA：同標記另一段\nB：我是同名'};
const participants=[{id:'p1',name:'同名'},{id:'p2',name:'同名'},{id:'p3',name:'第三人'}];
const build=(events=[])=>buildAttribution(meeting,participants,events);
const event=(id,actorId,action,segmentIds,targetId)=>({id,actorId,action,segmentIds,...(targetId===undefined?{}:{targetId})});
const snapshot=s=>({status:s.status,person:s.person,claimants:s.claimants});
const suggestion=(actorId,targetId)=>({actorId,targetId});
async function sourceIds(){return (await build()).segments.map(s=>s.id);}

test('cards: teammate proposal and target confirmation alone never establish a claimant or identity',async()=>{
  const [a]=await sourceIds();
  const proposed=await build([event('propose','p1','propose',[a],'p2')]);
  assert.deepEqual(proposed.segments[0].proposals,[suggestion('p1','p2')]);
  assert.deepEqual(snapshot(proposed.segments[0]),{status:'unclaimed',person:null,claimants:[]});
  const rejected=await build([event('propose','p1','propose',[a],'p2'),event('target-confirm','p2','confirm',[a]),event('author-confirm','p1','confirm',[a])]);
  assert.deepEqual(snapshot(rejected.segments[0]),{status:'unclaimed',person:null,claimants:[]});
  assert.ok(rejected.audit.slice(1).every(a=>a.outcome==='ignored'));
  const confirmed=await build([event('propose','p1','propose',[a],'p2'),event('own-claim','p2','claim',[a]),event('own-confirm','p2','confirm',[a])]);
  assert.equal(confirmed.segments[0].status,'confirmed');assert.equal(confirmed.segments[0].person.id,'p2');
  assert.deepEqual(confirmed.segments[0].claimants,[participants[1]]);
});
test('cards: proposal change and withdrawal cannot disturb confirmed or disputed claims',async()=>{
  const [a]=await sourceIds();
  const prefix=[event('claim','p2','claim',[a]),event('confirm','p2','confirm',[a])];
  for(const extra of [[],[event('conflict','p3','claim',[a])]]){
    const before=(await build([...prefix,...extra])).segments[0];
    const after=(await build([...prefix,...extra,event('propose','p1','propose',[a],'p3'),event('change','p1','propose',[a],'p2'),event('withdraw','p1','withdraw-proposal',[a])])).segments[0];
    assert.deepEqual(snapshot(after),snapshot(before));assert.deepEqual(after.proposals,[]);
  }
});
test('cards: proposals belong to actor IDs; equal names are distinct; one author replaces only own proposal',async()=>{
  const [a]=await sourceIds();
  const prefix=[event('one','p1','propose',[a],'p2'),event('two','p2','propose',[a],'p1')];
  const changed=await build([...prefix,event('update','p1','propose',[a],'p3')]);
  assert.deepEqual(changed.segments[0].proposals,[suggestion('p1','p3'),suggestion('p2','p1')]);
  const repeat=await build([...prefix,event('repeat','p1','propose',[a],'p2')]);
  assert.equal(repeat.audit.at(-1).outcome,'ignored');assert.equal(repeat.segments[0].proposals.length,2);
  const foreign=await build([...prefix,event('foreign','p3','withdraw-proposal',[a])]);
  assert.equal(foreign.audit.at(-1).outcome,'ignored');assert.deepEqual(foreign.segments[0].proposals,[suggestion('p1','p2'),suggestion('p2','p1')]);
  const own=await build([...prefix,event('own','p1','withdraw-proposal',[a])]);
  assert.deepEqual(own.segments[0].proposals,[suggestion('p2','p1')]);
});
test('cards: explicit batch proposal affects only selected segments and withdrawal does not propagate by source label',async()=>{
  const [a,continuation,otherA,b]=await sourceIds();
  const result=await build([event('batch','p1','propose',[a,b],'p2'),event('withdraw-first','p1','withdraw-proposal',[a])]);
  assert.deepEqual(result.segments.map(s=>s.proposals),[[],[],[],[suggestion('p1','p2')]]);
  assert.ok(result.segments.every(s=>s.status==='unclaimed'&&s.person===null&&s.claimants.length===0));
  assert.equal(result.audit.length,3);assert.notEqual(continuation,otherA);
});
function invalidEvents(a){
  return [
    event('invalid','p1','propose',[a]),event('invalid','p1','propose',[a],'p1'),event('invalid','p1','propose',[a],'missing'),
    ...[null,{},['p2'],2,'',true].map(targetId=>({id:'invalid',actorId:'p1',action:'propose',segmentIds:[a],targetId})),
    ...['claim','confirm','retract','withdraw-proposal'].flatMap(action=>['p2',null,undefined].map(targetId=>({id:'invalid',actorId:'p1',action,segmentIds:[a],targetId}))),
    event('invalid','p1','propose',[a,'stale-source-id'],'p2'),event('invalid','missing','propose',[a],'p2'),
    event('invalid','p1','propose',[a,a],'p2'),
  ];
}
test('cards: malformed and forged targets reject the entire replay without partial mutation',async()=>{
  const [a]=await sourceIds();const baseline=JSON.stringify(await build());
  for(const invalid of invalidEvents(a)){
    await assert.rejects(()=>build([event('valid','p1','propose',[a],'p2'),invalid]));
    assert.equal(JSON.stringify(await build()),baseline);
  }
});

async function fixture(t){
  let providerCalls=0;const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:{model:'test-only'},fetcher:async()=>{providerCalls++;throw Error('Provider forbidden');}});
  app.address=()=>({port:4173});t.after(()=>app.emit('close'));
  const dispatch=(url,headers={},body)=>new Promise(resolve=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(body)]);req.url=url;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173',...headers};
    const res={headersSent:false,writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},end(body){resolve({status:this.status,headers:this.headers,body});}};
    app.emit('request',req,res);
  });
  const home=await dispatch('/');assert.equal(home.status,200);const cookie=home.headers['Set-Cookie'].split(';')[0];
  const headers={cookie,origin:'http://127.0.0.1:4173','content-type':'application/json'};
  return {post:body=>dispatch('/api/attribution/demo',headers,JSON.stringify(body)),calls:()=>providerCalls};
}
test('cards actual HTTP handler: validates all target shapes atomically and preserves demo provenance',async t=>{
  const f=await fixture(t),[a]=await sourceIds();
  // JSON has no undefined value: own targetId:undefined is tested only at the core boundary.
  for(const invalid of invalidEvents(a).filter(e=>!(Object.hasOwn(e,'targetId')&&e.targetId===undefined&&e.action!=='propose'))){
    const response=await f.post({meeting,participants,events:[event('valid','p1','propose',[a],'p2'),invalid]});
    assert.equal(response.status,400,JSON.stringify(invalid));assert.equal(JSON.parse(response.body).segments,undefined);
  }
  const response=await f.post({meeting,participants,provenance:'notion',actorId:'p3',events:[event('valid','p1','propose',[a],'p2'),event('forged-confirm','p2','confirm',[a])]});
  assert.equal(response.status,200,response.body);const result=JSON.parse(response.body);
  assert.equal(result.provenance,'demo');assert.deepEqual(result.segments[0].proposals,[suggestion('p1','p2')]);
  assert.deepEqual(snapshot(result.segments[0]),{status:'unclaimed',person:null,claimants:[]});assert.equal(f.calls(),0);
});

// Executes the shipped script with inert DOM nodes; no network socket or browser assumptions.
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
  for(const [key,value] of Object.entries({'meeting-title':'UI independent','meeting-date':'2026-10-31','meeting-mode':'rules',transcript:'A：UI原話','demo-actor':'demo-pinyu'}))elements.get(key).value=value;
  const document={listeners:{},addEventListener(type,handler){this.listeners[type]=handler;},getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text),querySelectorAll:()=>[],activeElement:null,body:new Element('body')};
  const context=vm.createContext({document,Option:function(text,value){const n=new Element('option',text);n.value=value;return n;},AbortController,fetch:fetcher,Set,Map,Date,crypto,console,navigator:{},Blob,URL,setTimeout:(fn,delay)=>{const timer=setTimeout(fn,delay);timer.unref?.();return timer;},clearTimeout});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1]+`;globalThis.ui={request,invalidate,render,renderPeople,setMode,act,getData:()=>data,getEvents:()=>events,setData:x=>{data=x},setEvents:x=>{events=x}};`,context);
  return {ui:context.ui,elements,html,document};
}
function nodes(root){return [root,...root.children.flatMap(nodes)];}
function textOf(root){return nodes(root).map(n=>n.textContent).join(' ');}
const uiRows=()=>[
  {id:'confirmed-one',lineIndex:0,text:'原話 <img src=x onerror=alert(1)>',sourceLabel:'A',sourceLabelOrigin:'explicit',status:'confirmed',person:{id:'one',name:'同名'},claimants:[{id:'one',name:'同名'}],proposals:[],hints:[]},
  {id:'confirmed-two',lineIndex:1,text:'同一人物另一段\t原話',sourceLabel:'B',sourceLabelOrigin:'explicit',status:'confirmed',person:{id:'one',name:'同名'},claimants:[{id:'one',name:'同名'}],proposals:[],hints:[]},
  {id:'proposal-only',lineIndex:2,text:'A：未確認原話',sourceLabel:'A',sourceLabelOrigin:'explicit',status:'unclaimed',person:null,claimants:[],proposals:[suggestion('demo-pinyu','demo-guanting')],hints:[]},
  {id:'continuation',lineIndex:3,text:'　延伸原話仍須獨立認領　',sourceLabel:'A',sourceLabelOrigin:'continuation',status:'unclaimed',person:null,claimants:[],proposals:[],hints:[]},
  {id:'same-name-other',lineIndex:4,text:'另一位同名原話',sourceLabel:'C',sourceLabelOrigin:'explicit',status:'confirmed',person:{id:'two',name:'同名'},claimants:[{id:'two',name:'同名'}],proposals:[],hints:[]},
];
test('cards UI contract: excerpts use exact confirmed person IDs, preserve raw text, and never infer identity from proposal or label',()=>{
  const f=uiFixture(),rows=uiRows();f.ui.setData({meetingId:'ui',provenance:'demo',segments:rows});f.ui.renderPeople();f.ui.render();
  assert.deepEqual(f.elements.get('person-filter').children.slice(1).map(n=>n.value),['one','two']);
  const articles=f.elements.get('segments').children;assert.equal(articles.length,5);
  // Lazy excerpts are rendered by the real details toggle, then retain all content assertions.
  for(const article of articles){const details=nodes(article).find(n=>n.tagName==='details');details.open=true;details.ontoggle();}
  const firstExcerpts=nodes(articles[0]).filter(n=>n.className==='excerpt');assert.equal(firstExcerpts.length,2);
  assert.ok(textOf(firstExcerpts[0]).includes(rows[0].text));assert.ok(textOf(firstExcerpts[1]).includes(rows[1].text));
  assert.ok(!textOf(articles[0]).includes(rows[4].text));
  const pendingExcerpts=nodes(articles[2]).filter(n=>n.className==='excerpt');
  assert.ok(textOf(articles[2]).includes('待本人認領確認'));assert.ok(!pendingExcerpts.some(n=>textOf(n).includes(rows[3].text)));
  assert.equal(nodes(articles[2]).find(n=>n.className==='identity-name').textContent,'原文標記 A');
  assert.ok(textOf(articles[3]).includes(rows[3].text));assert.ok(textOf(articles[3]).includes('段落 ID · continuation'));
  f.elements.get('person-filter').value='one';f.ui.render();assert.equal(f.elements.get('segments').children.length,2);
  assert.ok(!textOf(f.elements.get('segments')).includes(rows[2].text));
});
test('cards UI contract: teammate button sends explicit target and own withdrawal omits target; another actor gets no withdrawal button',async()=>{
  const requests=[],rows=uiRows();const f=uiFixture(async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({meetingId:'ui',provenance:'demo',segments:rows,audit:[]})};});
  f.ui.setData({meetingId:'ui',provenance:'demo',segments:rows});f.ui.render();
  let article=f.elements.get('segments').children[2];
  const target=nodes(article).find(n=>n.tagName==='select');assert.deepEqual(target.children.map(n=>n.value),['demo-guanting']);target.value='demo-guanting';
  await nodes(article).find(n=>n.tagName==='button'&&n.textContent==='幫隊友標註').onclick();
  let sent=requests.at(-1).body.events.at(-1);assert.equal(sent.action,'propose');assert.equal(sent.actorId,'demo-pinyu');assert.equal(sent.targetId,'demo-guanting');assert.deepEqual(sent.segmentIds,['proposal-only']);
  article=f.elements.get('segments').children[2];await nodes(article).find(n=>n.textContent==='撤回我的建議').onclick();
  sent=requests.at(-1).body.events.at(-1);assert.equal(sent.action,'withdraw-proposal');assert.equal(Object.hasOwn(sent,'targetId'),false);
  f.elements.get('demo-actor').value='demo-guanting';f.elements.get('demo-actor').onchange();article=f.elements.get('segments').children[2];
  assert.equal(nodes(article).some(n=>n.textContent==='撤回我的建議'),false);
  assert.equal(requests.length,2);
});
test('cards UI contract: Notion snapshot renders suggestions safely without any proposal write control or event request',async()=>{
  let requests=0;const f=uiFixture(async()=>{requests++;throw Error('Notion action must not write');});f.ui.setMode('notion');
  const rows=uiRows();f.ui.setData({meetingId:'notion-ui',provenance:'notion',segments:rows,participants:[{id:'demo-pinyu',name:'<script>actor</script>'},{id:'demo-guanting',name:'<img onerror=x>'}]});f.ui.render();
  const tree=nodes(f.elements.get('segments'));assert.equal(tree.some(n=>n.tagName==='select'),false);
  assert.equal(tree.some(n=>['幫隊友標註','撤回我的建議','這句是我說的','確認是我'].includes(n.textContent)),false);
  assert.ok(textOf(f.elements.get('segments')).includes('<script>actor</script> 建議是 <img onerror=x>'));
  await f.ui.act('propose',['proposal-only'],'demo-guanting');await f.ui.act('withdraw-proposal',['proposal-only']);assert.equal(requests,0);
});
test('cards UI contract: confirmed proposal target displays completed confirmation, and differing target displays disagreement',()=>{
  const f=uiFixture(),rows=uiRows();
  rows[0].proposals=[suggestion('demo-pinyu','one'),suggestion('demo-guanting','two')];
  f.ui.setData({meetingId:'confirmed-proposal',provenance:'demo',segments:rows});f.ui.render();
  const proposalNotes=nodes(f.elements.get('segments').children[0]).filter(n=>n.className==='proposal-note');
  assert.equal(proposalNotes.length,2);
  assert.ok(proposalNotes[0].textContent.includes('本人已確認'));
  assert.ok(proposalNotes[1].textContent.includes('與目前確認歸屬不同'));
  assert.ok(proposalNotes.every(n=>!n.textContent.includes('待本人')));
});
test('cards UI contract: compact controls show only relevant own action and reveal bulk after explicit selection',()=>{
  const f=uiFixture(),rows=uiRows();
  rows[0].person={id:'demo-pinyu',name:'品妤'};rows[0].claimants=[rows[0].person];
  rows[1].person=null;rows[1].status='pending';rows[1].claimants=[{id:'demo-pinyu',name:'品妤'}];
  f.ui.setData({meetingId:'compact',provenance:'demo',segments:rows});f.ui.render();
  assert.equal(f.elements.get('bulk').hidden,true);
  const articles=f.elements.get('segments').children;
  const mainActions=article=>nodes(article).find(n=>n.className==='segment-actions');
  assert.equal(nodes(mainActions(articles[0])).some(n=>n.tagName==='button'),false);
  assert.deepEqual(nodes(mainActions(articles[1])).filter(n=>n.tagName==='button').map(n=>n.textContent),['確認是我']);
  assert.deepEqual(nodes(mainActions(articles[2])).filter(n=>n.tagName==='button').map(n=>n.textContent),['這句是我說的']);
  const checkbox=nodes(articles[2]).find(n=>n.tagName==='input'&&n.type==='checkbox');checkbox.checked=true;checkbox.onchange();
  assert.equal(f.elements.get('bulk').hidden,false);assert.ok(f.elements.get('selection-count').textContent.includes('1 段'));
});
test('cards iOS contract: unchanged cards reuse nodes, a changed card preserves neighboring nodes and focused controls',()=>{
  const f=uiFixture(),rows=uiRows();f.ui.setData({meetingId:'keyed',provenance:'demo',segments:rows});f.ui.render();
  const before=[...f.elements.get('segments').children],focus=nodes(before[4]).find(n=>n.tagName==='summary');focus.focus();
  f.ui.render();assert.ok(f.elements.get('segments').children.every((card,i)=>card===before[i]));assert.equal(f.document.activeElement,focus);
  rows[2]={...rows[2],proposals:[suggestion('demo-guanting','demo-pinyu')]};
  f.ui.render();const after=f.elements.get('segments').children;
  assert.notEqual(after[2],before[2]);for(const i of [0,1,3,4])assert.equal(after[i],before[i]);assert.equal(f.document.activeElement,focus);
  assert.ok(!after[2].className.split(' ').includes('is-new'));
});
test('cards iOS contract: request feedback uses a nonblocking polite status and does not replace unchanged card nodes',async()=>{
  const rows=uiRows(),f=uiFixture(async()=>({ok:true,json:async()=>({meetingId:'feedback',provenance:'demo',segments:rows,audit:[]})}));
  f.ui.setData({meetingId:'feedback',provenance:'demo',segments:rows});f.ui.render();const before=[...f.elements.get('segments').children];
  await f.ui.request();assert.ok(f.elements.get('segments').children.every((card,i)=>card===before[i]));
  assert.ok(f.elements.get('activity-toast').textContent.includes('已更新'));assert.equal(f.elements.get('activity-toast').hidden,false);
  assert.match(f.html,/<[^>]*id="activity-toast"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(f.html,/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});
test('cards long-meeting contract: 200 rows render bounded initial cards, reveal later rows, reset filters and bound lazy excerpts',()=>{
  const f=uiFixture(),rows=Array.from({length:200},(_,i)=>({id:'long-'+i,lineIndex:i,text:'A：原話 '+i+(i===199?' 最後特徵':''),sourceLabel:'A',sourceLabelOrigin:'explicit',status:'confirmed',person:{id:i%2?'same-name-two':'same-name-one',name:'同名'},claimants:[{id:i%2?'same-name-two':'same-name-one',name:'同名'}],proposals:[],hints:[]}));
  f.ui.setData({meetingId:'long',provenance:'demo',segments:rows});f.ui.renderPeople();f.ui.render();
  let cards=f.elements.get('segments').children;const initial=cards.length;
  assert.ok(initial>0&&initial<=40);assert.ok(f.elements.get('counts').textContent.includes('/ 200 段'));
  assert.equal(nodes(f.elements.get('segments')).filter(n=>n.className==='excerpt').length,0);
  const first=cards[0],highlights=nodes(first).find(n=>n.tagName==='details');highlights.open=true;highlights.ontoggle();
  assert.ok(nodes(highlights).filter(n=>n.className==='excerpt').length<=20);assert.ok(textOf(highlights).includes('共 100 段'));assert.ok(textOf(highlights).includes('前 20 段'));
  f.elements.get('show-more').onclick();cards=f.elements.get('segments').children;
  assert.ok(cards.length>initial);assert.equal(cards[0],first);assert.ok(textOf(cards.at(-1)).includes('long-'+(cards.length-1)));
  f.elements.get('person-filter').value='same-name-two';f.elements.get('person-filter').onchange();cards=f.elements.get('segments').children;
  assert.ok(cards.length<=40);assert.ok(f.elements.get('counts').textContent.includes('/ 100 段'));assert.ok(f.elements.get('counts').textContent.includes('全篇 200 段'));
  for(const card of cards){const id=nodes(card).find(n=>n.className==='segment-id').textContent.match(/long-(\d+)/)[1];assert.equal(Number(id)%2,1);}
  f.elements.get('literal-query').value='最後特徵';f.elements.get('literal-query').oninput();cards=f.elements.get('segments').children;
  assert.equal(cards.length,1);assert.ok(textOf(cards[0]).includes('long-199'));assert.ok(f.elements.get('counts').textContent.includes('顯示 1 / 1 段'));
  f.elements.get('person-filter').value='';f.elements.get('literal-query').value='';f.elements.get('literal-query').oninput();
  assert.equal(f.elements.get('segments').children.length,initial);assert.ok(f.elements.get('counts').textContent.includes('/ 200 段'));
});
test('desktop floating contract: hover and focus reveal exact source in an aside without claiming or sending a request',()=>{
  let calls=0;const f=uiFixture(async()=>{calls++;throw Error('Hover must not send');}),rows=uiRows(),before=JSON.stringify(rows);
  f.ui.setData({meetingId:'hover',provenance:'demo',segments:rows});f.ui.render();
  const cards=f.elements.get('segments').children,first=cards[0],highlights=nodes(first).find(n=>n.tagName==='details');
  first.onmouseenter();assert.equal(highlights.open,true);assert.equal(highlights.children[1].tagName,'aside');
  const excerpts=nodes(highlights).filter(n=>n.className==='excerpt');assert.equal(excerpts.length,2);
  assert.ok(textOf(excerpts[0]).includes(rows[0].text));assert.ok(textOf(excerpts[1]).includes(rows[1].text));assert.ok(!textOf(highlights).includes(rows[4].text));
  const metadata=nodes(first).filter(n=>n.tagName==='details')[1],summary=metadata.children[0];summary.focus();assert.equal(calls,0);summary.onclick({preventDefault(){}});
  assert.equal(metadata.open,true);assert.equal(highlights.open,false);assert.ok(textOf(metadata).includes('確認歸屬：同名 · one'));
  f.document.listeners.keydown({key:'Escape',preventDefault(){}});
  cards[3].onmouseenter();const unknown=nodes(cards[3]).find(n=>n.tagName==='details');assert.equal(unknown.open,true);
  assert.equal(nodes(cards[3]).find(n=>n.className==='identity-name').textContent,'未獨立標記');assert.ok(textOf(cards[3]).includes('沿用 A 僅供閱讀'));assert.ok(textOf(cards[3]).includes('原文標記：A'));assert.equal(rows[3].person,null);
  assert.equal(JSON.stringify(rows),before);assert.equal(f.ui.getEvents().length,0);assert.equal(calls,0);
});
test('desktop floating contract: explicit summary click pins, Escape closes and restores focus, then only claim click sends a claim',async()=>{
  const rows=uiRows(),requests=[],f=uiFixture(async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({meetingId:'explicit',provenance:'demo',segments:rows,audit:[]})};});
  f.ui.setData({meetingId:'explicit',provenance:'demo',segments:rows});f.ui.render();
  let card=f.elements.get('segments').children[2],details=nodes(card).find(n=>n.tagName==='details'),summary=details.children[0],prevented=0;
  // Native summary keyboard activation dispatches this same click handler; browser must verify Enter/Space itself.
  summary.onclick({preventDefault(){prevented++;}});assert.equal(prevented,1);assert.equal(details.open,true);assert.equal(details.getAttribute('data-pinned'),'true');assert.equal(summary.getAttribute('aria-expanded'),'true');
  f.document.listeners.keydown({key:'Escape',preventDefault(){prevented++;}});assert.equal(details.open,false);assert.equal(summary.getAttribute('aria-expanded'),'false');assert.equal(f.document.activeElement,summary);assert.equal(requests.length,0);
  const claim=nodes(card).find(n=>n.tagName==='button'&&n.textContent==='這句是我說的');await claim.onclick();
  assert.equal(requests.length,1);const sent=requests[0].body.events.at(-1);assert.equal(sent.action,'claim');assert.equal(sent.actorId,'demo-pinyu');assert.deepEqual(sent.segmentIds,['proposal-only']);assert.equal(Object.hasOwn(sent,'targetId'),false);
});
test('desktop floating contract: Notion hover, focus, pin and Escape stay local and preserve unconfirmed source',async()=>{
  let calls=0;const f=uiFixture(async()=>{calls++;throw Error('Notion preview cannot write');}),rows=uiRows();f.ui.setMode('notion');
  f.ui.setData({meetingId:'notion-hover',provenance:'notion',segments:rows});f.ui.render();const card=f.elements.get('segments').children[2];
  card.onmouseenter();const metadata=nodes(card).filter(n=>n.tagName==='details')[1],summary=metadata.children[0];summary.focus();summary.onclick({preventDefault(){}});
  assert.equal(metadata.open,true);assert.ok(textOf(metadata).includes('尚未確認'));assert.equal(nodes(card).some(n=>n.textContent==='幫隊友標註'),false);
  f.document.listeners.keydown({key:'Escape',preventDefault(){}});assert.equal(metadata.open,false);
  await f.ui.act('claim',['proposal-only']);await f.ui.act('propose',['proposal-only'],'demo-guanting');assert.equal(calls,0);assert.equal(f.ui.getEvents().length,0);
});
test('desktop floating regression: hovering another card preserves pinned source until explicit summary click changes it',()=>{
  let calls=0;const f=uiFixture(async()=>{calls++;throw Error('Preview cannot send');});f.ui.setData({meetingId:'pin-regression',provenance:'demo',segments:uiRows()});f.ui.render();
  const cards=f.elements.get('segments').children,first=nodes(cards[0]).find(n=>n.tagName==='details'),second=nodes(cards[1]).find(n=>n.tagName==='details');
  first.children[0].onclick({preventDefault(){}});assert.equal(first.open,true);assert.equal(first.getAttribute('data-pinned'),'true');
  cards[1].onmouseenter();assert.equal(first.open,true);assert.equal(second.open,false);assert.equal(first.getAttribute('data-pinned'),'true');
  second.children[0].onclick({preventDefault(){}});assert.equal(first.open,false);assert.equal(second.open,true);assert.equal(second.getAttribute('data-pinned'),'true');assert.equal(calls,0);
});
test('desktop floating regression: arrange restores dragged card coordinates through actual pointer handlers while reusing its node',()=>{
  let calls=0;const f=uiFixture(async()=>{calls++;throw Error('Arrangement cannot send');});f.ui.setData({meetingId:'arrange-regression',provenance:'demo',segments:uiRows()});f.ui.render();
  const card=f.elements.get('segments').children[0],initial=card.getAttribute('style'),head=nodes(card).find(n=>n.className==='segment-head');
  head.listeners.pointerdown({button:0,target:head,clientX:10,clientY:10,pointerId:7});
  head.listeners.pointermove({clientX:120,clientY:160,pointerId:7});assert.notEqual(card.getAttribute('style'),initial);
  head.listeners.pointerup({pointerId:7});f.elements.get('arrange-cards').onclick();
  assert.equal(f.elements.get('segments').children[0],card);assert.equal(card.getAttribute('style'),initial);assert.equal(calls,0);
});
test('desktop dispute regression: own disputed claim has no confirm action, conflict claim feedback requires dispute resolution',async()=>{
  const rows=uiRows();rows[2]={...rows[2],status:'disputed',claimants:[{id:'demo-pinyu',name:'品妤'},{id:'demo-guanting',name:'冠廷'}]};
  const f=uiFixture(async()=>({ok:true,json:async()=>({meetingId:'disputed-ui',provenance:'demo',segments:rows,audit:[]})}));
  f.ui.setData({meetingId:'disputed-ui',provenance:'demo',segments:rows});f.ui.render();
  const card=f.elements.get('segments').children[2],actions=nodes(card).find(n=>n.className==='segment-actions');
  assert.equal(nodes(actions).some(n=>n.tagName==='button'),false);assert.ok(nodes(card).some(n=>n.tagName==='button'&&n.textContent==='撤回本人聲明'));
  await f.ui.act('claim',['proposal-only']);const toast=f.elements.get('activity-toast').textContent;assert.ok(toast.includes('先處理歸屬爭議'));assert.ok(!toast.includes('接著確認'));
  assert.equal(f.ui.getData().segments[2].person,null);assert.equal(f.ui.getData().segments[2].status,'disputed');
});
test('desktop dispute regression: partly ignored batch confirmation reports unconfirmed rows instead of claiming complete success',async()=>{
  const rows=uiRows();rows[0]={...rows[0],person:{id:'demo-pinyu',name:'品妤'},claimants:[{id:'demo-pinyu',name:'品妤'}]};
  rows[2]={...rows[2],status:'disputed',claimants:[{id:'demo-pinyu',name:'品妤'},{id:'demo-guanting',name:'冠廷'}]};
  let body;const f=uiFixture(async(url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({meetingId:'partial-confirm',provenance:'demo',segments:rows,audit:[]})};});
  f.ui.setData({meetingId:'partial-confirm',provenance:'demo',segments:rows});await f.ui.act('confirm',['confirmed-one','proposal-only']);
  assert.deepEqual(body.events.at(-1).segmentIds,['confirmed-one','proposal-only']);assert.ok(f.elements.get('activity-toast').textContent.includes('部分段落尚未確認'));
  assert.equal(f.ui.getData().segments[0].person.id,'demo-pinyu');assert.equal(f.ui.getData().segments[2].person,null);assert.equal(f.ui.getData().segments[2].status,'disputed');
});
test('desktop source-origin regression: unconfirmed continuation excerpts only itself; confirmed continuation uses exact person group',()=>{
  const f=uiFixture(),rows=uiRows();f.ui.setData({meetingId:'continuation-excerpts',provenance:'demo',segments:rows});f.ui.render();
  let card=f.elements.get('segments').children[3];card.onmouseenter();let details=nodes(card).find(n=>n.tagName==='details');
  let excerpts=nodes(details).filter(n=>n.className==='excerpt');assert.equal(excerpts.length,1);assert.ok(textOf(excerpts[0]).includes(rows[3].text));
  assert.ok(!textOf(details).includes(rows[0].text));assert.ok(!textOf(details).includes(rows[2].text));assert.ok(!textOf(details).includes('同原文標記的其他段落'));
  f.document.listeners.keydown({key:'Escape',preventDefault(){}});
  rows[3]={...rows[3],status:'confirmed',person:{id:'one',name:'同名'},claimants:[{id:'one',name:'同名'}]};f.ui.render();
  card=f.elements.get('segments').children[3];card.onmouseenter();details=nodes(card).find(n=>n.tagName==='details');excerpts=nodes(details).filter(n=>n.className==='excerpt');
  assert.equal(excerpts.length,3);for(const i of [0,1,3])assert.ok(excerpts.some(n=>textOf(n).includes(rows[i].text)));
  assert.ok(!textOf(details).includes(rows[2].text));assert.ok(!textOf(details).includes(rows[4].text));
});
