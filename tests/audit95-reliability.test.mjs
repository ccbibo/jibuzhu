// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { summarizeTeam } from '../lib/team-summary.ts';
import { providerFetch } from '../lib/providers.ts';
import { createApplication } from '../standalone/server.mjs';
import { buildAttribution } from '../lib/attribution.ts';
import { buildManagerBoard } from '../lib/manager-board.ts';

// Independent GATE regressions assert repaired behavior after reproducible audit findings.
// All credentials and provider responses are synthetic; no network and no config loader.
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
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1]+`;globalThis.ui={request,invalidate,render,renderPeople,setMode,renderManagerBoard,setManagerView,renderTeamAI,checkTeamAI,runTeamAI,updateTeamAIControls,getData:()=>data,setData:x=>{data=x},getTracking:()=>managerTracking,getHighlights:()=>managerHighlights,getConfigured:()=>teamAIConfigured};`,context);
  return {ui:context.ui,elements,context};
}
function uiText(node){return node.textContent+' '+node.children.map(uiText).join(' ');}
function nodes(root){return [root,...root.children.flatMap(nodes)];}
function buttons(root,text){return nodes(root).filter(n=>n.tagName==='button'&&n.textContent===text);}

const meeting={title:'Reliability audit',meetingDate:'2026-10-31',mode:'rules',transcript:'A：我會整理報告。'};
const envelope=()=>Response.json({status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify({items:[],caveats:[]})}]}]});
const config=()=>({provider:'openai',openaiKey:'synthetic-openai',deepseekKey:'synthetic-deepseek',model:'synthetic-model'});

test('GATE: a settings change mid-summary cannot change the destination for later chunks',async()=>{
 const current=config(),destinations=[];
 const result=await summarizeTeam({meeting:{...meeting,transcript:'文'.repeat(14000)},approved:true,provider:'openai'},current,async(url)=>{
  destinations.push(url);if(destinations.length===1){current.provider='deepseek';current.model='changed-model';}return envelope();
 });
 assert.equal(result.coverage.complete,true);
 assert.deepEqual(destinations,Array(3).fill('https://api.openai.com/v1/responses'));
});

test('GATE: providerFetch rejects pre-aborted caller signal before any provider call',async()=>{
 const cancel=new AbortController();cancel.abort();let calls=0;
 await assert.rejects(providerFetch('https://synthetic.invalid',{signal:cancel.signal},async()=>{calls++;return Response.json({ok:true});}),e=>e.status===499);
 assert.equal(calls,0);
});

async function apiFixture(t,fetcher){
 const current=config();const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:current,fetcher});app.address=()=>({port:4173});t.after(()=>app.emit('close'));
 const dispatch=(route,body,cookie)=>{let req;const promise=new Promise(resolve=>{req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);req.url=route;req.method=body?'POST':'GET';req.headers={host:'127.0.0.1:4173',cookie,origin:'http://127.0.0.1:4173','content-type':'application/json'};const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){resolve(new Response(body??null,{status:this.status,headers:this.headers}));}};app.emit('request',req,res);});return {promise,getReq:()=>req};};
 const home=await dispatch('/speakers').promise;return {current,dispatch,cookie:home.headers.get('set-cookie').split(';')[0]};
}
test('GATE: stale OpenAI approval is rejected when runtime provider changed to DeepSeek',async t=>{
 const sent=[];const f=await apiFixture(t,async url=>{sent.push(url);return envelope();});
 const displayed=await (await f.dispatch('/api/status',null,f.cookie).promise).json();assert.equal(displayed.provider,'openai');
 f.current.provider='deepseek';
 const res=await f.dispatch('/api/team-summary',{meeting,approved:true,provider:'openai'},f.cookie).promise;
 assert.ok(res.status>=400);assert.deepEqual(sent,[]);
});
test('GATE: aborting incoming summary prevents all later provider chunks',async t=>{
 let release,started;const firstStarted=new Promise(r=>started=r);let calls=0;
 const f=await apiFixture(t,async()=>{calls++;if(calls===1){started();await new Promise(r=>release=r);}return envelope();});
 const request=f.dispatch('/api/team-summary',{meeting:{...meeting,transcript:'文'.repeat(14000)},approved:true,provider:'openai'},f.cookie);
 await firstStarted;request.getReq().emit('aborted');release();
 assert.equal((await request.promise).status,499);assert.equal(calls,1);
});
test('GATE: refreshing identical meeting attribution preserves manual owner and AI output',async()=>{
 let answer;const f=uiFixture(async url=>({ok:true,json:async()=>url==='/api/status'?{aiConfigured:true,provider:'openai',model:'test'}:answer}));const first=await buildAttribution(meeting,[{id:'one',name:'A'}],[]);first.managerBoard=await buildManagerBoard(meeting,first);f.ui.setData(first);f.ui.renderManagerBoard();
 buttons(f.elements.get('manager-content'),'納入追蹤')[0].onclick();
 const owner=nodes(f.elements.get('manager-content')).find(n=>n.tagName==='input');owner.value='manual owner';owner.oninput();
 answer={mode:'ai',meetingId:first.meetingId,items:[],caveats:[],coverage:{characters:meeting.transcript.length,chunkCount:1,processedChunks:1,complete:true}};await f.ui.checkTeamAI();f.elements.get('team-ai-approved').checked=true;await f.ui.runTeamAI();
 assert.equal(f.ui.getTracking().size,1);assert.ok(f.elements.get('team-ai-results').children.length);
 const refreshed=await buildAttribution(meeting,[{id:'one',name:'A'}],[]);refreshed.managerBoard=await buildManagerBoard(meeting,refreshed);assert.equal(refreshed.meetingId,first.meetingId);
 f.ui.setData(refreshed);f.ui.renderManagerBoard();
 assert.equal(f.ui.getTracking().size,1);assert.equal([...f.ui.getTracking().values()][0].assignee,'manual owner');assert.ok(f.elements.get('team-ai-results').children.length);
});
test('GATE: team AI citation navigates to the matching full source card',async()=>{
 const f=uiFixture();const data=await buildAttribution(meeting,[{id:'one',name:'A'}],[]);data.managerBoard=await buildManagerBoard(meeting,data);f.ui.setData(data);f.ui.renderManagerBoard();
 f.ui.renderTeamAI({items:[{id:'finding',kind:'highlight',text:'summary',citations:[{lineIndex:0,quote:'我會整理報告。'}]}],caveats:[],coverage:{characters:meeting.transcript.length,chunkCount:1,processedChunks:1,complete:true}});
 const quotes=nodes(f.elements.get('team-ai-results')).filter(n=>n.tagName==='blockquote');assert.equal(quotes.length,1);
 const jump=nodes(quotes[0]).find(n=>n.tagName==='button');assert.ok(jump);jump.onclick();assert.equal(f.elements.get('canvas-main').hidden,false);assert.equal(f.elements.get('person-filter').value,'');assert.equal(f.elements.get('literal-query').value,'');assert.equal(f.context.document.activeElement.getAttribute('tabindex'),'-1');
});

test('GATE: all standalone AI entry points reject absent or mismatched provider consent before sending',async t=>{
 const calls=[];const f=await apiFixture(t,async url=>{calls.push(url);return envelope();});
 for(const route of ['/api/team-summary','/api/ask','/api/extract']){
  for(const extra of [{},{approved:true},{approved:true,provider:'deepseek'},{approved:false,provider:'openai'}]){
   const body=route==='/api/extract'?{...meeting,mode:'ai',...extra}:{meeting:{...meeting,mode:'ai'},question:'誰整理？',...extra};
   const res=await f.dispatch(route,body,f.cookie).promise;assert.ok(res.status>=400,route+' '+JSON.stringify(extra));
  }
 }
 assert.deepEqual(calls,[]);
});

test('GATE: an adopted AI candidate retains its manual owner/status without duplication on same-meeting refresh',async()=>{
 const candidateMeeting={...meeting,transcript:'A：我建議保留備案。'};
 const f=uiFixture();const load=async()=>{const d=await buildAttribution(candidateMeeting,[{id:'one',name:'A'}],[]);d.managerBoard=await buildManagerBoard(candidateMeeting,d);f.ui.setData(d);f.ui.renderManagerBoard();return d;};
 await load();f.ui.renderTeamAI({items:[{id:'ai-only',kind:'task',text:'候選整理',citations:[{lineIndex:0,quote:'我建議保留備案。'}]}],caveats:[],coverage:{characters:15,chunkCount:1,processedChunks:1,complete:true}});
 buttons(f.elements.get('team-ai-results'),'納入追蹤')[0].onclick();
 const review=f.ui.getTracking().get('ai:ai-only');review.assignee='manual AI owner';review.status='done';
 const next=await load();assert.equal(review.assignee,'manual AI owner');assert.equal(f.ui.getTracking().get('ai:ai-only').assignee,'manual AI owner');assert.equal(f.ui.getTracking().get('ai:ai-only').status,'done');assert.equal(next.managerBoard.tasks.filter(t=>t.id==='ai:ai-only').length,1);
});

test('GATE: invalidating source hides previous review and rebuilding another meeting clears it',async()=>{
 const f=uiFixture();const first=await buildAttribution(meeting,[{id:'one',name:'A'}],[]);first.managerBoard=await buildManagerBoard(meeting,first);f.ui.setData(first);f.ui.renderManagerBoard();buttons(f.elements.get('manager-content'),'納入追蹤')[0].onclick();
 f.ui.invalidate();assert.equal(f.ui.getData(),null);assert.equal(buttons(f.elements.get('manager-content'),'納入追蹤').length,0);assert.equal(f.elements.get('team-ai-run').disabled,true);
 const changed={...meeting,transcript:'B：今天只討論備案。'};const next=await buildAttribution(changed,[{id:'two',name:'B'}],[]);next.managerBoard=await buildManagerBoard(changed,next);assert.notEqual(first.meetingId,next.meetingId);f.ui.setData(next);f.ui.renderManagerBoard();assert.equal(f.ui.getTracking().size,0);
});
