// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createApplication } from '../standalone/server.mjs';
import { providerFetch, extractAI } from '../lib/providers.ts';
import { askMeeting } from '../lib/meeting-qa.ts';
import { summarizeTeam } from '../lib/team-summary.ts';
import { meetingKey } from '../lib/task-engine.ts';
const config={provider:'openai',model:'test-only',openaiKey:'synthetic-private-key'};
const meeting={title:'取消測試',meetingDate:'2026-10-31',mode:'ai',transcript:'A：我會整理初稿。'};
const envelope=value=>Response.json({status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
async function fixture(t,fetcher){
 const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:{...config},fetcher});app.address=()=>({port:4173});t.after(()=>app.emit('close'));
 const begin=(route,body,cookie)=>{
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url=route;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173',origin:'http://127.0.0.1:4173','content-type':'application/json',cookie};
  const res=new EventEmitter();res.writableEnded=false;
  const promise=new Promise(resolve=>{res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};res.end=body=>{res.writableEnded=true;resolve({status:res.status,headers:res.headers,text:body});res.emit('close');};});
  app.emit('request',req,res);return {req,res,promise};
 };
 const home=await begin('/').promise,cookie=home.headers['Set-Cookie'].split(';')[0];
 return {begin:(route,body)=>begin(route,body,cookie)};
}
test('providerFetch merges caller cancellation instead of replacing it and sanitizes abort reasons',async()=>{
 const controller=new AbortController();let called=0;
 await assert.rejects(()=>providerFetch('https://example.invalid',{signal:controller.signal},async(_url,init)=>{
  called++;assert.ok(init.signal instanceof AbortSignal);controller.abort('synthetic-private-key');assert.equal(init.signal.aborted,true);throw Error('synthetic-private-key');
 }),e=>e.status===499&&!e.message.includes('synthetic-private-key'));
 assert.equal(called,1);
 await assert.rejects(()=>providerFetch('https://example.invalid',{signal:controller.signal},async()=>{called++;}),e=>e.status===499);assert.equal(called,1);
});
test('pre-aborted signals stop all three AI features before any provider call',async()=>{
 const controller=new AbortController();controller.abort('synthetic-private-key');let called=0;const fetcher=async()=>{called++;throw Error('unexpected');};
 const c={...config,signal:controller.signal};
 for(const run of [()=>extractAI(meeting,c,fetcher),()=>askMeeting({meeting,question:'承諾？',speaker:'',approved:true,provider:'openai'},c,fetcher),()=>summarizeTeam({meeting,approved:true,provider:'openai'},c,fetcher)])await assert.rejects(run,e=>e.status===499);
 assert.equal(called,0);
});
test('summary cancellation after the first chunk never transmits the second chunk',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(()=>summarizeTeam({meeting:{...meeting,transcript:'文'.repeat(14000)},approved:true,provider:'openai'},{...config,signal:controller.signal},async()=>{calls++;controller.abort();return envelope({items:[],caveats:[]});}),e=>e.status===499);
 assert.equal(calls,1);
});
test('response close cancels an active summary and releases the in-flight lock for the next request',async t=>{
 let current,calls=0,abortObserved=false;
 const f=await fixture(t,async(_url,init)=>{calls++;if(calls===1){current.res.emit('close');abortObserved=init.signal.aborted;}return envelope({items:[],caveats:[]});});
 current=f.begin('/api/team-summary',{meeting:{...meeting,transcript:'文'.repeat(14000)},approved:true,provider:'openai'});
 const first=await current.promise;assert.equal(first.status,499);assert.equal(calls,1);assert.equal(abortObserved,true);assert.ok(!first.text.includes('synthetic-private-key'));
 const second=await f.begin('/api/team-summary',{meeting,approved:true,provider:'openai'}).promise;assert.equal(second.status,200);assert.equal(calls,2);
});
test('request aborted reaches upstream cancellation in ask and extract routes',async t=>{
 for(const [route,body] of [['/api/ask',{meeting,question:'承諾？',speaker:''}],['/api/extract',{...meeting}]]){
  let current,calls=0;
  const f=await fixture(t,async(_url,init)=>{calls++;current.req.emit('aborted');assert.equal(init.signal.aborted,true);return envelope({});});
  current=f.begin(route,{...body,approved:true,provider:'openai'});assert.equal((await current.promise).status,499);assert.equal(calls,1);
 }
});
test('local handoff validation rejects changed versions and false evidence without contacting a provider',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;throw Error('forbidden');});
 const id=await meetingKey(meeting),task={title:'整理初稿',assignee:null,dueDate:null,dueText:null,priority:'normal',evidence:'我會整理初稿。',lineIndex:0,warnings:[]};
 const valid=await f.begin('/api/validate-tasks',{meeting,meetingId:id,tasks:[task]}).promise;assert.equal(valid.status,200);assert.equal(JSON.parse(valid.text).tasks.length,1);
 for(const body of [{meeting:{...meeting,transcript:meeting.transcript+'新增'},meetingId:id,tasks:[task]},{meeting,meetingId:id,tasks:[{...task,evidence:'偽造原文'}]}])assert.equal((await f.begin('/api/validate-tasks',body).promise).status,400);
 assert.equal(calls,0);
});
