// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { recallMeeting } from '../lib/recall-engine.ts';
import { askMeeting } from '../lib/meeting-qa.ts';
import { createApplication } from '../standalone/server.mjs';
const meeting = transcript => ({title:'tester02 synthetic source',meetingDate:'2026-10-31',mode:'ai',transcript});
const recall = (transcript,query,speaker='') => recallMeeting({meeting:meeting(transcript),query,speaker});
const answer = claims => ({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({claims,caveats:[]})}]}]});
const claim = (lineIndex,quote) => ({text:'合成模型主張，未驗證語意',kind:'unknown',citations:[{lineIndex,quote}]});
const ask = (transcript,claims,speaker='') => askMeeting({meeting:meeting(transcript),question:'測試問題',speaker},{model:'test',openaiKey:'synthetic-key'},async()=>Response.json(answer(claims)));

test('tester02 exact source bytes, blank CRLF positions, first and last context',async()=>{
 const lines=['  前言 RAG  ','甲：RAG','', '[00:01:02.123] 乙：RAG','末行 RAG',''];
 const r=await recall(lines.join('\r\n'),'RAG');
 assert.deepEqual(r.hits.map(h=>h.lineIndex),[0,1,3,4]);
 for(const hit of r.hits){assert.equal(hit.text,lines[hit.lineIndex]);for(const c of hit.context) assert.equal(c.text,lines[c.lineIndex]);}
 assert.deepEqual(r.hits[0].context.map(x=>x.lineIndex),[0,1]);
 assert.deepEqual(r.hits.at(-1).context.map(x=>[x.lineIndex,x.text]),[[3,lines[3]],[4,lines[4]],[5,'']]);
 assert.equal(r.hits[0].speaker,null);assert.equal(r.hits.at(-1).speaker,'乙');
});
test('tester02 literal metacharacters, misleading names and case-only matching',async()=>{
 const text='甲：小林支持 [x] a.* RAG\n小林：反對 [x] a.* RAG\n小林同學：支持 [x] a.* RAG\n乙：支持 x abcd RAG';
 assert.deepEqual((await recall(text,'[x] a.* rag','小林')).hits.map(x=>x.lineIndex),[1]);
 assert.equal((await recall(text,'支持','小林')).totalMatches,0);
 assert.equal((await recall(text,'小林','甲')).totalMatches,1);
 assert.equal((await recall(text,'不存在')).totalMatches,0);
});
test('tester02 40-hit truncation preserves count and out-of-window adjacent context',async()=>{
 const lines=Array.from({length:43},(_,i)=>`${i%2?'乙':'甲'}：命中 ${i}`);
 const r=await recall(lines.join('\r\n'),'命中');
 assert.equal(r.totalMatches,43);assert.equal(r.truncated,true);assert.equal(r.hits.length,40);
 assert.deepEqual(r.hits[39].context.map(c=>c.lineIndex),[38,39,40]);assert.equal(r.hits[39].context[2].text,lines[40]);
 assert.equal((await recall(lines.slice(0,40).join('\n'),'命中')).truncated,false);
});
test('tester02 AI exact CRLF-derived quotation and original attribution',async()=>{
 const r=await ask('前言\r\n甲：提到乙\r\n\r\n乙：保留  雙空格',[claim(3,'保留  雙空格')],'乙');
 assert.deepEqual(r.claims[0].citations,[{lineIndex:3,quote:'保留  雙空格',speaker:'乙'}]);
 assert.match(r.notice,/不等於語意/);
});
test('tester02 one invalid AI quote rejects entire answer, no partial salvage',async()=>{
 for(const bad of [claim(0,'改寫'),claim(9,'甲'),claim(0,' '),claim(0,'第一行\n第二行'),claim(1,'第一行'),claim(-1,'甲'),claim(0.5,'甲')])
  await assert.rejects(ask('甲：第一行\n第二行',[claim(0,'第一行'),bad]),/引用校驗失敗/);
 await assert.rejects(ask('甲：保留  雙空格',[claim(0,'保留 雙空格')]),/引用校驗失敗/);
});
test('tester02 AI speaker filter cannot be satisfied by prose mention or forged model speaker',async()=>{
 await assert.rejects(ask('甲：乙支持\n乙：反對',[claim(0,'乙支持')],'乙'),/引用校驗失敗/);
 await assert.rejects(ask('甲：原文',[{...claim(0,'原文'),citations:[{lineIndex:0,quote:'原文',speaker:'乙'}]}]),/引用校驗失敗/);
 const r=await ask('甲：原文',[],'乙');assert.deepEqual(r.claims,[]);
});
test('tester02 API body guards operate without outbound calls',async t=>{
 let calls=0;const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:{model:'test'},fetcher:async()=>{calls++;throw Error('forbidden');}});
 app.address=()=>({port:4173});t.after(()=>app.emit('close'));
 const dispatch=(method,route,body,headers={})=>new Promise(resolve=>{
 const req=Readable.from(body===undefined?[]:[Buffer.from(body)]);req.method=method;req.url=route;req.headers={host:'127.0.0.1:4173',...headers};
 const res={headersSent:false,writeHead(status,h){this.status=status;this.headers=h;this.headersSent=true;},end(body){resolve({status:this.status,headers:this.headers,body});}};app.emit('request',req,res);});
 const cookie=(await dispatch('GET','/')).headers['Set-Cookie'].split(';')[0];
 const headers={cookie,origin:'http://127.0.0.1:4173','content-type':'application/json'};
 const body=JSON.stringify({meeting:meeting('甲：原文'),query:'原文',speaker:''});
 for(const [override,status] of [[{cookie:''},401],[{origin:'https://evil.example'},403],[{'sec-fetch-site':'cross-site'},403],[{'content-type':'text/plain'},415],[{'content-type':'application/json-pwn'},415],[{host:'evil.example'},403]]) assert.equal((await dispatch('POST','/api/recall',body,{...headers,...override})).status,status);
 for(const invalid of ['{', 'null','[]', '中'.repeat(53334)]) assert.equal((await dispatch('POST','/api/recall',invalid,headers)).status,400);
 assert.equal((await dispatch('POST','/api/recall',body,headers)).status,200);assert.equal(calls,0);
});

test('tester02 integrated ask guards, no-key 503 and shared extract rate limit',async t=>{
 async function fixture(config){let calls=0;const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config,fetcher:async()=>{calls++;return Response.json(answer([claim(2,'保留原文')]));}});app.address=()=>({port:4173});t.after(()=>app.emit('close'));
 const dispatch=(route,body,headers={})=>new Promise(resolve=>{const req=Readable.from(body===undefined?[]:[Buffer.from(body)]);req.url=route;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173',...headers};const res={headersSent:false,writeHead(status,h){this.status=status;this.headers=h;this.headersSent=true;},end(body){resolve({status:this.status,headers:this.headers,body});}};app.emit('request',req,res);});
 const cookie=(await dispatch('/')).headers['Set-Cookie'].split(';')[0];const headers={cookie,origin:'http://127.0.0.1:4173','content-type':'application/json'};
 return {dispatch,headers,calls:()=>calls};}
 const raw={meeting:meeting('甲：前言\r\n\r\n乙：保留原文'),question:'乙說了什麼？',speaker:'乙'};const body=JSON.stringify(raw);
 const missing=await fixture({model:'test'});assert.equal((await missing.dispatch('/api/ask',body,missing.headers)).status,503);assert.equal(missing.calls(),0);
 const f=await fixture({model:'test',openaiKey:'synthetic-key'});
 for(const [override,status] of [[{cookie:''},401],[{origin:'https://evil.example'},403],[{'content-type':'text/plain'},415]]) assert.equal((await f.dispatch('/api/ask',body,{...f.headers,...override})).status,status);
 assert.equal((await f.dispatch('/api/ask','{',f.headers)).status,400);assert.equal((await f.dispatch('/api/ask','中'.repeat(53334),f.headers)).status,400);assert.equal(f.calls(),0);
 for(let i=0;i<5;i++){const r=await f.dispatch('/api/ask',body,f.headers);assert.equal(r.status,200,r.body);assert.equal(JSON.parse(r.body).claims[0].citations[0].lineIndex,2);}
 const throttled=await f.dispatch('/api/extract',JSON.stringify(raw.meeting),f.headers);assert.equal(throttled.status,429);assert.equal(throttled.headers['Retry-After'],'60');assert.equal(f.calls(),5);
});

test('tester02 cross challenge unbracketed time cannot fabricate numeric speaker',async()=>{
 for(const clock of ['09:31','09:31:20.123']) {
 const text=`小林：風險開始\n${clock} 風險仍在討論\n風險續行\n小陳：風險收尾`;
 assert.deepEqual((await recall(text,'風險','小林')).hits.map(h=>h.lineIndex),[0,1,2],clock);
 const r=await ask(text,[claim(2,'風險續行')],'小林');
 assert.equal(r.claims[0].citations[0].speaker,'小林');
 }
});
