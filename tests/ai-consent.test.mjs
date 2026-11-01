// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApplication } from '../standalone/server.mjs';
import { summarizeTeam } from '../lib/team-summary.ts';
const meeting={title:'供應商同意',meetingDate:'2026-10-31',mode:'ai',transcript:'A：我會整理初稿。'};
const config=()=>({provider:'openai',model:'openai-original',openaiKey:'openai-original-key',deepseekKey:'deepseek-new-key'});
const envelope=value=>Response.json({status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
async function fixture(t,c,fetcher){
 const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:c,fetcher});app.address=()=>({port:4173});t.after(()=>app.emit('close'));
 const dispatch=(route,body,cookie)=>new Promise(resolve=>{const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url=route;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173',origin:'http://127.0.0.1:4173','content-type':'application/json',cookie};const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){resolve({status:this.status,headers:this.headers,body:JSON.parse(this.headers['Content-Type'].startsWith('application/json')?body:'null')});}};app.emit('request',req,res);});
 const home=await dispatch('/');const cookie=home.headers['Set-Cookie'].split(';')[0];return {post:(route,body)=>dispatch(route,body,cookie),status:()=>dispatch('/api/status',undefined,cookie)};
}
const bodies=[['/api/extract',{...meeting}],['/api/ask',{meeting,question:'承諾？',speaker:''}],['/api/team-summary',{meeting}]];
test('all AI routes reject missing approval, provider and stale destination/model before any transmission',async t=>{
 let calls=0;const c=config(),f=await fixture(t,c,async()=>{calls++;throw Error('forbidden');});
 assert.equal((await f.status()).body.provider,'openai');
 for(const [route,body] of bodies){
  assert.equal((await f.post(route,body)).status,400);
  assert.equal((await f.post(route,{...body,approved:true})).status,400);
  assert.equal((await f.post(route,{...body,approved:false,provider:'openai'})).status,400);
  assert.equal((await f.post(route,{...body,approved:true,provider:'deepseek'})).status,409);
  assert.equal((await f.post(route,{...body,approved:true,provider:'openai',model:'stale-model'})).status,409);
 }
 c.provider='deepseek';c.model='deepseek-flash';
 for(const [route,body] of bodies)assert.equal((await f.post(route,{...body,approved:true,provider:'openai',model:'openai-original'})).status,409);
 assert.equal(calls,0);
 const rules=await f.post('/api/extract',{...meeting,mode:'rules'});assert.equal(rules.status,200);assert.equal(calls,0);
});
test('summary snapshots supplier, model and key before awaits for every chunk',async()=>{
 const c=config(),calls=[];
 const r=await summarizeTeam({meeting:{...meeting,transcript:'文'.repeat(14000)},approved:true,provider:'openai',model:'openai-original'},c,async(url,init)=>{
  calls.push({url,key:init.headers.Authorization,body:JSON.parse(init.body)});
  c.provider='deepseek';c.model='deepseek-flash';c.openaiKey='changed-openai-key';
  return envelope({items:[],caveats:[]});
 });
 assert.equal(r.coverage.processedChunks,3);assert.equal(calls.length,3);
 for(const call of calls){assert.equal(call.url,'https://api.openai.com/v1/responses');assert.equal(call.key,'Bearer openai-original-key');assert.equal(call.body.model,'openai-original');}
});
test('a live API request cannot switch supplier between summary chunks after runtime settings mutation',async t=>{
 const c=config(),calls=[];
 const f=await fixture(t,c,async(url,init)=>{calls.push({url,key:init.headers.Authorization,model:JSON.parse(init.body).model});c.provider='deepseek';c.model='deepseek-flash';c.openaiKey='mutated';return envelope({items:[],caveats:[]});});
 const r=await f.post('/api/team-summary',{meeting:{...meeting,transcript:'文'.repeat(14000)},approved:true,provider:'openai',model:'openai-original'});
 assert.equal(r.status,200);assert.equal(calls.length,3);assert.ok(calls.every(v=>v.url==='https://api.openai.com/v1/responses'&&v.key==='Bearer openai-original-key'&&v.model==='openai-original'));
});
