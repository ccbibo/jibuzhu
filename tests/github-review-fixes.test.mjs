import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createApplication } from '../standalone/server.mjs';
import { extractAI, notionPayload } from '../lib/providers.ts';

// Isolated request handler: no real config, persistent data, TCP or provider calls.
async function fixture(t) {
  let providerCalls=0;
  const app=createApplication({databasePath:':memory:',config:{provider:'openai',model:'synthetic'},fetcher:async()=>{providerCalls++;throw Error('External calls forbidden');}});
  app.address=()=>({port:4173});t.after(()=>app.emit('close'));
  const jar=new Map();
  const request=(route,body,headers={})=>new Promise(resolve=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url=route;req.method=body===undefined?'GET':'POST';
    req.headers={host:'127.0.0.1:4173',origin:'http://127.0.0.1:4173','content-type':'application/json',cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...headers};
    const res={writeHead(status,hs){this.status=status;this.headers=hs;},end(raw){const set=this.headers['Set-Cookie'];for(const cookie of Array.isArray(set)?set:set?[set]:[]){const pair=cookie.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}resolve({status:this.status,body:JSON.parse(raw||'null')});}};
    app.emit('request',req,res);
  });
  await request('/api/session');
  const register=(email,name,headers)=>request('/api/auth/register',{email,name,password:'Synthetic-password-2026'},headers);
  return {request,register,providerCalls:()=>providerCalls};
}

test('GitHub fix gate: stale tab account binding blocks profile and sync after browser cookie switches accounts',async t=>{
  const f=await fixture(t),a=await f.register('a@example.test','Account A');assert.equal(a.status,201);
  const aId=a.body.user.id;
  const b=await f.register('b@example.test','Account B',{'x-account-id':aId});assert.equal(b.status,201,'auth registration permits deliberate identity changes');
  const bId=b.body.user.id;assert.notEqual(aId,bId);
  for(const [route,body] of [['/api/auth/profile',{name:'A intended edit',avatar:'preset:3',userId:bId}],['/api/sync',{approved:true}]]){
    const response=await f.request(route,body,{'x-account-id':aId});
    assert.equal(response.status,409,route);assert.equal(response.body.code,'account_changed',route);
  }
  const current=await f.request('/api/auth/me');assert.equal(current.body.user.id,bId);assert.equal(current.body.user.name,'Account B');
  assert.equal(f.providerCalls(),0,'stale sync must reject before reading Notion schema');
  assert.equal((await f.request('/api/auth/profile',{name:'Confirmed B'},{'x-account-id':bId})).status,200);
  assert.equal((await f.request('/api/auth/me')).body.user.name,'Confirmed B');
});

test('GitHub fix gate: legacy no-header requests remain supported, while headers never grant another identity',async t=>{
  const f=await fixture(t),created=await f.register('legacy@example.test','Legacy');assert.equal(created.status,201);
  assert.equal((await f.request('/api/auth/profile',{name:'Legacy edit'})).status,200);
  const denied=await f.request('/api/auth/profile',{name:'Should not persist'},{'x-account-id':'invented-other-account'});
  assert.equal(denied.status,409);assert.equal(denied.body.code,'account_changed');
  assert.equal((await f.request('/api/auth/me')).body.user.name,'Legacy edit');assert.equal(f.providerCalls(),0);
});

test('GitHub fix gate: explicit login and registration ignore old account-binding headers',async t=>{
  const f=await fixture(t),a=await f.register('first@example.test','First');
  await f.register('second@example.test','Second');
  const stale={'x-account-id':a.body.user.id};
  const login=await f.request('/api/auth/login',{email:'second@example.test',password:'Synthetic-password-2026'},stale);
  assert.equal(login.status,200,'an intentional login must not be trapped by the previous page account');
  const registered=await f.register('third@example.test','Third',stale);assert.equal(registered.status,201);
  assert.equal(f.providerCalls(),0);
});

test('GitHub fix gate: actual account client binds writes to A, locks on B-cookie conflict and on focus identity change',async t=>{
  const f=await fixture(t),a=await f.register('client-a@example.test','Client A');
  class Element{
    constructor(){this.children=[];this.style={};this.textContent='';}
    append(...items){this.children.push(...items);}prepend(...items){this.children.unshift(...items);}setAttribute(){}
  }
  async function client(){
    const calls=[],events=new Map(),storage=new Map(),body=new Element(),header=new Element();
    const window={addEventListener:(type,callback)=>events.set(type,callback),sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
    const fetch=async(url,init={})=>{
      const headers=Object.fromEntries(new Headers(init.headers).entries());calls.push({url,headers});
      const result=await f.request(url,init.body?JSON.parse(init.body):undefined,headers);
      const response=()=>({status:result.status,ok:result.status<400,json:async()=>result.body,clone:response});return response();
    };
    const context=vm.createContext({window,document:{body,createElement:()=>new Element(),querySelector:()=>header,addEventListener(){},visibilityState:'visible'},location:{origin:'http://127.0.0.1:4173',pathname:'/account',search:'',replace(){},assign(){}},fetch,URL,Headers,Date});
    for(const name of ['workspace','account'])vm.runInContext(readFileSync(new URL('../public/assets/'+name+'.js',import.meta.url),'utf8'),context);
    assert.equal((await window.JibuzhuAuthReady).id,a.body.user.id);
    assert.equal(window.JibuzhuWorkspace.saveMeeting({id:'private-a',title:'A private',meetingDate:'2026-11-01',transcript:'A source',mode:'rules'}),true);
    return {window,events,calls,body};
  }
  const first=await client();await f.register('client-b@example.test','Client B');
  const conflict=await first.window.fetch('/api/auth/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Must not modify B'})});
  assert.equal(first.calls.at(-1).headers['x-account-id'],a.body.user.id);
  assert.equal(conflict.status,409);assert.equal((await conflict.json()).code,'account_changed');
  assert.equal((await f.request('/api/auth/me')).body.user.name,'Client B');
  assert.equal(first.window.JibuzhuWorkspace.readMeeting(),null);assert.equal(first.body.children.length,1,'conflict creates blocking account-change mask');
  const sent=first.calls.length;
  await assert.rejects(first.window.fetch('/api/auth/profile',{method:'POST',body:'{}'}),/帳號|工作台/);
  assert.equal(first.calls.length,sent,'a locked stale page cannot send another write');
  await f.request('/api/auth/login',{email:'client-a@example.test',password:'Synthetic-password-2026'});
  const focused=await client();
  await f.request('/api/auth/login',{email:'client-b@example.test',password:'Synthetic-password-2026'});
  await focused.events.get('focus')();
  assert.equal(focused.window.JibuzhuWorkspace.readMeeting(),null);assert.equal(focused.body.children.length,1);
  const afterFocus=focused.calls.length;
  await assert.rejects(focused.window.fetch('/api/auth/profile',{method:'POST',body:'{}'}),/帳號|工作台/);
  assert.equal(focused.calls.length,afterFocus);assert.equal(f.providerCalls(),0);
});

const schema={titleName:'任務',targetName:'Synthetic tasks',properties:{任務:{type:'title'},'來源 ID':{type:'rich_text'},截止日期:{type:'date'}}};
async function aiTask(transcript,dueDate,dueText){
  const meeting={title:'Synthetic meeting',meetingDate:'2026-11-01',mode:'ai',transcript};
  const config={provider:'openai',model:'synthetic',openaiKey:'synthetic',dataSourceId:'synthetic-source'};
  const response={status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify({summary:'Synthetic',tasks:[{title:'整理報告',assignee:'小明',dueDate,dueText,priority:'normal',evidence:transcript,lineIndex:0,warnings:[]}]})}]}]};
  const result=await extractAI(meeting,config,async()=>Response.json(response));
  const task=result.tasks[0],payload=notionPayload(config,schema,task,meeting,'synthetic-id');
  return {task,paragraph:payload.children[2].paragraph.rich_text.map(x=>x.text.content).join('')};
}

test('GitHub fix gate: hallucinated AI deadline text is cleared with unsupported parsed date and cannot be exported as original',async()=>{
  const {task,paragraph}=await aiTask('小明：我會整理報告。','2026-11-20','2026-11-20');
  assert.equal(task.dueDate,null);assert.equal(task.dueText,null);assert.doesNotMatch(paragraph,/2026-11-20/);
  assert.ok(task.warnings.some(w=>/期限|日期/.test(w)));
});

test('GitHub fix gate: invented fuzzy deadline is cleared even when model supplies no parsed date',async()=>{
  const {task,paragraph}=await aiTask('小明：我會整理報告。',null,'下週三');
  assert.equal(task.dueText,null);assert.doesNotMatch(paragraph,/原文：下週三/);
});

test('GitHub fix gate: genuine quoted relative deadline remains available for review and original export',async()=>{
  const {task,paragraph}=await aiTask('小明：我會下週三整理報告。',null,'下週三');
  assert.equal(task.dueText,'下週三');assert.equal(task.dueDate,null);assert.match(paragraph,/原文：下週三/);
});
