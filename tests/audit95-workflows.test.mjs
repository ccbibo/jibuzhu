// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createApplication } from '../standalone/server.mjs';

// Independent audit: real request handlers; every provider request terminates in this mock.
function server(t) {
 const calls=[],pages=new Map(),schema={任務:{type:'title'},'來源 ID':{type:'rich_text'},負責人:{type:'rich_text'},截止日期:{type:'date'},優先級:{type:'select'}};
 const text=r=>(r||[]).map(v=>v.text?.content||'').join('');
 const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:{openaiKey:'audit-only',model:'audit-mock',notionToken:'audit-only',dataSourceId:'audit'},fetcher:async(url,init={})=>{
  calls.push({url,init});const u=new URL(url),body=init.body?JSON.parse(init.body):{};
  if(u.hostname==='api.openai.com')return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({items:[{kind:'task',text:'AI獨有：聯絡廠商',citations:[{lineIndex:1,quote:'我建議聯絡廠商。'}]}],caveats:[]})}]}]});
  assert.equal(u.hostname,'api.notion.com');
  if(u.pathname==='/v1/data_sources/audit')return Response.json({properties:schema});
  if(u.pathname.endsWith('/query'))return Response.json({results:[...pages.values()].filter(p=>text(p.properties['來源 ID'].rich_text)===body.filter.rich_text.equals).map(p=>({id:p.id})),has_more:false});
  if(u.pathname==='/v1/pages'){const id='audit-page-'+(pages.size+1);const p={...body,id,archived:false,in_trash:false};for(const [k,v]of Object.entries(p.properties)){v.type=schema[k].type;if(v.type==='date'&&v.date)v.date={...v.date,end:null,time_zone:null};}pages.set(id,p);return Response.json({id});}
  const id=u.pathname.split('/')[3],page=pages.get(id);assert.ok(page,'Unexpected mock request '+url);
  if(u.pathname.endsWith('/children'))return Response.json({results:page.children.map((v,i)=>({...v,id:'b'+i,has_children:false,archived:false,in_trash:false})),has_more:false,next_cursor:null});
  return Response.json(page);
 }});
 app.address=()=>({port:4173});t.after(()=>app.emit('close'));let cookie='';
 const dispatch=async(route,options={})=>new Promise(resolve=>{const req=Readable.from(options.body?[Buffer.from(options.body)]:[]);req.url=route;req.method=options.method||'GET';req.headers={host:'127.0.0.1:4173',cookie,origin:'http://127.0.0.1:4173','content-type':'application/json'};app.emit('request',req,{writeHead(status,headers){this.status=status;this.headers=headers;},end(body){if(this.headers?.['Set-Cookie'])cookie=this.headers['Set-Cookie'].split(';')[0];resolve(new Response(body,{status:this.status,headers:this.headers}));}});});
 return {dispatch,calls,pages,storage:new Map()};
}

// DOM contract only: no layout/browser claims. Run each shipped script without rewriting it.
function ui(html,fetcher,storage=new Map()){
 const elements=new Map(),downloads=[];
 class Element{
  constructor(tag='div',text=''){this.tagName=tag;this.textContent=text;this.children=[];this.value='';this.listeners={};this.attrs={};this.dataset={};this.style={};this.classList={add(){},remove(){},toggle(){}};}
  get childNodes(){return this.children;}
  append(...xs){xs.forEach(x=>this.insertBefore(x,null));}
  insertBefore(x,ref){x.parentNode?.removeChild(x);this.children.splice(ref?this.children.indexOf(ref):this.children.length,0,x);x.parentNode=this;return x;}
  removeChild(x){this.children.splice(this.children.indexOf(x),1);x.parentNode=null;}
  replaceChildren(...xs){this.children=[];this.textContent='';this.append(...xs);}
  contains(x){return this===x||this.children.some(c=>c.contains(x));}
  get isConnected(){return true;}
  set innerHTML(s){this._html=s;for(const m of s.matchAll(/id="([^"]+)"/g))if(!elements.has(m[1]))elements.set(m[1],new Element());}
  get innerHTML(){return this._html||'';}
  querySelector(s){return s.startsWith('#')?get(s.slice(1)):new Element(s);}
  querySelectorAll(){return [];}
  setAttribute(k,v){this.attrs[k]=v;} getAttribute(k){return this.attrs[k]??null;} removeAttribute(k){delete this.attrs[k];}
  addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
  async fire(k,event={}){for(const fn of this.listeners[k]||[])await fn({target:this,preventDefault(){},...event});}
  focus(){} scrollIntoView(){} checkValidity(){return true;} click(){} remove(){} setCustomValidity(){} reportValidity(){}
 }
 const get=id=>elements.get(id)||[...elements.values()].flatMap(walk).find(x=>x.id===id);
 for(const m of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*id="([^"]+)"[^>]*>/g)){const el=new Element(m[1]);el.id=m[2];el.value=m[0].match(/\bvalue="([^"]*)"/)?.[1]||'';elements.set(m[2],el);}
 for(const m of html.matchAll(/<textarea[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g))get(m[1]).value=m[2];
 for(const m of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>\s*<option value="([^"]*)"/g))get(m[1]).value=m[2];
 const document={getElementById:get,createElement:tag=>new Element(tag),createTextNode:t=>new Element('#text',t),querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],addEventListener(){},body:new Element('body')};
 const windowEvents={},navigation=[];const window={sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},location:{assign:p=>navigation.push(p)},addEventListener:(k,fn)=>{(windowEvents[k]??=[]).push(fn);}};
 const context=vm.createContext({document,window,fetch:fetcher,Option:function(t,v){const e=new Element('option',t);e.value=v;return e;},AbortController,TextDecoder,TypeError,Blob,URL:{createObjectURL:b=>{downloads.push(b);return 'blob:audit';},revokeObjectURL(){}},crypto,console,navigator:{},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,Date});
 vm.runInContext(readFileSync(new URL('../public/assets/workspace.js',import.meta.url),'utf8'),context);
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
 return {$:get,run:s=>vm.runInContext(s,context),downloads,navigation,leave:()=>{for(const fn of windowEvents.pagehide||[])fn();}};
}
function walk(n){return [n,...n.children.flatMap(walk)];}
const btn=(u,id,label)=>walk(u.$(id)).find(n=>n.tagName==='button'&&n.textContent===label);
const flush=()=>new Promise(r=>setImmediate(r));
async function ready(u,predicate){for(let i=0;i<100&&!u.run(predicate);i++)await flush();assert.equal(u.run(predicate),true,'UI did not settle: '+predicate);}
const meeting={title:'AUDIT95獨立來源',meetingDate:'2026-11-01',mode:'rules',transcript:'A：我會在明天整理預算。\nA：我建議聯絡廠商。'};
async function open(s,route){const r=await s.dispatch(route);assert.equal(r.status,200);return ui(await r.text(),s.dispatch,s.storage);}

test('AUDIT regression: imported source survives normal navigation across all three workspaces',async t=>{
 const s=server(t),recall=await open(s,'/');await flush();const bytes=new TextEncoder().encode(meeting.transcript);
 recall.$('source-file').files=[{name:'audit.txt',size:bytes.length,arrayBuffer:async()=>bytes.buffer}];await recall.$('source-file').fire('change');
 assert.equal(recall.$('transcript').value,meeting.transcript);assert.equal(s.calls.length,0);
 recall.leave();const speakers=await open(s,'/speakers');await flush();assert.equal(speakers.$('transcript').value,meeting.transcript);
 speakers.leave();const tasks=await open(s,'/tasks');await flush();assert.equal(tasks.$('transcript').value,meeting.transcript);assert.notEqual(tasks.$('meeting-title').value,'分校營運週會');
});

test('AUDIT regression: unchanged-source claim and refresh preserve manual tracking, highlights and AI candidate',async t=>{
 const s=server(t),u=await open(s,'/speakers');for(const [id,v]of Object.entries({'meeting-title':meeting.title,'meeting-date':meeting.meetingDate,transcript:meeting.transcript}))u.$(id).value=v;
 await u.run('request()');const source=u.run('data.meetingId');
 btn(u,'manager-content','納入追蹤').onclick();btn(u,'manager-content','標記為重點').onclick();
 const input=walk(u.$('manager-content')).find(n=>n.tagName==='input');input.value='人工負責人';input.oninput();
 const status=walk(u.$('manager-content')).find(n=>n.tagName==='select');status.value='doing';status.onchange();
 await u.run('checkTeamAI()');u.$('team-ai-approved').checked=true;await u.run('runTeamAI()');
 btn(u,'team-ai-results','納入追蹤').onclick();assert.equal(u.run('managerTracking.size'),2);assert.equal(u.run('data.managerBoard.tasks.length'),2);
 await u.run("act('claim',[data.segments[0].id])");
 assert.equal(u.run('data.meetingId'),source);assert.equal(u.run('data.segments[0].status'),'pending');
 assert.equal(u.run('managerTracking.size'),2);assert.equal(u.run('managerHighlights.size'),1);assert.equal(u.run('data.managerBoard.tasks.length'),2);assert.ok(u.$('team-ai-results').children.length>0);
 assert.equal(u.run("[...managerTracking.values()].some(t=>t.assignee==='人工負責人'&&t.status==='doing')"),true);
 const aiCalls=s.calls.filter(c=>c.url.includes('api.openai.com')).length;
 u.leave();const fresh=await open(s,'/speakers');await ready(fresh,'!controller&&!teamAIChecking');assert.equal(fresh.run('managerTracking.size'),2,fresh.$('status').textContent);assert.equal(fresh.run('managerHighlights.size'),1);assert.equal(fresh.run('data.managerBoard.tasks.length'),2);assert.equal(fresh.run('data.meetingId'),source);assert.equal(fresh.$('team-ai-approved').checked,false);assert.equal(s.calls.filter(c=>c.url.includes('api.openai.com')).length,aiCalls);
 fresh.$('export').onclick();const exported=JSON.parse(await fresh.downloads[0].text());assert.ok(exported.review.tracking.some(t=>t.assignee==='人工負責人'&&t.status==='doing'));assert.equal(exported.review.highlights.length,1);assert.equal(exported.review.aiTasks.length,1);
 fresh.$('transcript').value+='\nB：另一場來源';await fresh.$('transcript').fire('input');await fresh.run('request()');assert.notEqual(fresh.run('data.meetingId'),source);assert.equal(fresh.run('managerTracking.size'),0);assert.equal(fresh.run('managerHighlights.size'),0);assert.equal(fresh.run('managerAITasks.size'),0);
});

test('AUDIT regression: reviewed rules and AI tasks hand off to delivery with manual owners and verified Notion output',async t=>{
 const s=server(t),u=await open(s,'/speakers');for(const [id,v]of Object.entries({'meeting-title':meeting.title,'meeting-date':meeting.meetingDate,transcript:meeting.transcript}))u.$(id).value=v;
 await u.run('request()');btn(u,'manager-content','納入追蹤').onclick();const owner=walk(u.$('manager-content')).find(n=>n.tagName==='input');owner.value='人工負責人';owner.oninput();
 await u.run('checkTeamAI()');u.$('team-ai-approved').checked=true;await u.run('runTeamAI()');btn(u,'team-ai-results','納入追蹤').onclick();
 await u.run('sendManagerHandoff()');assert.deepEqual(u.navigation,['/tasks']);u.leave();
 const task=await open(s,'/tasks');await ready(task,'!state.busy');assert.equal(task.$('transcript').value,meeting.transcript);assert.equal(task.run('state.tasks.length'),2,task.$('alert').innerHTML);assert.equal(task.run('state.tasks[0].assignee'),'人工負責人');assert.equal(task.run('state.tasks[1].title'),'AI獨有：聯絡廠商');assert.equal(task.run('state.reviewed'),false);
 task.run('state.reviewed=true;state.acknowledged=true');await task.run('sync()');assert.equal(task.run('Object.values(state.results).every(r=>r.status==="created")'),true);assert.equal(s.pages.size,2);
 await task.run('verifyButton.onclick()');assert.equal(task.$('verify-output').children.length,2);assert.ok(task.$('verify-output').children.every(n=>n.textContent.includes('讀回相符')));
 task.run('state.acknowledged=true');await task.run('sync()');assert.equal(s.pages.size,2,'A repeat delivery must not create duplicate pages');
 task.leave();const fresh=await open(s,'/speakers');await ready(fresh,'!controller&&!teamAIChecking');assert.equal(fresh.run('managerTracking.size'),2);assert.equal(fresh.run('data.meetingId'),task.run('state.extraction.meetingId'));
});

// Release QA: execute the shipped inline handlers against actual attribution API data.
// Deferred /api/ask responses below are synthetic; this is not a browser/model test.
async function personQuestionFixture(t){
 const s=server(t),html=await (await s.dispatch('/speakers')).text();let resolve;
 const calls=[];const u=ui(html,(route,options)=>{if(route==='/api/ask'){calls.push(JSON.parse(options.body));return new Promise(r=>resolve=r);}return s.dispatch(route,options);});
 await flush();for(const [id,v]of Object.entries({'meeting-title':meeting.title,'meeting-date':meeting.meetingDate,transcript:meeting.transcript}))u.$(id).value=v;
 await u.run('request()');const key=u.run('data.managerBoard.people[0].id');await u.run('openPersonAI('+JSON.stringify(key)+')');
 return {u,calls,respond:(status,value)=>resolve(Response.json(value,{status}))};
}

test('release QA: person AI requires explicit consent and sends original source labels despite a display rename',async t=>{
 const {u,calls,respond}=await personQuestionFixture(t);
 u.run("managerProfiles.set(personAIKey,{displayName:'顯示名不等於原文'});personAIPreset()");
 await u.$('person-ai-send').onclick();assert.equal(calls.length,0);
 u.$('person-ai-approved').checked=true;const pending=u.$('person-ai-send').onclick();assert.equal(calls.length,1);
 assert.equal(calls[0].speaker,'A');assert.equal(calls[0].meeting.transcript,meeting.transcript);assert.equal(calls[0].approved,true);assert.equal(calls[0].provider,'openai');assert.ok(!calls[0].question.includes('顯示名不等於原文'));
 respond(200,{mode:'ai',meetingId:u.run('data.meetingId'),claims:[],caveats:['原文不足']});await pending;assert.match(u.$('person-ai-feedback').textContent,/依據不足/);
});

test('release QA: stopped and closed person AI requests reject late success and late failure',async t=>{
 for(const action of ['stop','close']){
  const {u,respond}=await personQuestionFixture(t);u.$('person-ai-approved').checked=true;const pending=u.$('person-ai-send').onclick();
  if(action==='stop')u.$('person-ai-stop').onclick();else u.$('person-ai-close').onclick();
  const status=u.$('person-ai-feedback').textContent;respond(action==='stop'?200:502,{mode:'ai',meetingId:u.run('data.meetingId'),claims:[{text:'STALE ANSWER',citations:[]}],error:'STALE ERROR'});await pending;
  assert.equal(u.$('person-ai-answer').children.length,0);assert.equal(u.$('person-ai-feedback').textContent,status);assert.equal(u.run('personAIAbort'),null);
 }
});

test('release QA: person AI rejects mismatched meeting and requires fresh consent on provider conflict',async t=>{
 for(const status of [200,409,502]){
  const {u,respond}=await personQuestionFixture(t);u.$('person-ai-approved').checked=true;const pending=u.$('person-ai-send').onclick();respond(status,{mode:'ai',meetingId:'another-meeting',claims:[{text:'WRONG SOURCE',citations:[]}],error:'synthetic provider unavailable'});await pending;
  assert.equal(u.$('person-ai-answer').children.length,0);assert.equal(u.run('personAIAbort'),null);assert.match(u.$('person-ai-feedback').textContent,status===200?/不符/:status===409?/重新同意/:/synthetic provider unavailable/);
  if(status===409){assert.equal(u.$('person-ai-approved').checked,false);assert.equal(u.$('person-ai-send').disabled,true);}
 }
});
