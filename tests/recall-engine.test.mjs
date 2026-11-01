// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { recallMeeting } from '../lib/recall-engine.ts';
import { createApplication } from '../standalone/server.mjs';
const meeting={title:'合成回找測試',meetingDate:'2026-10-31',mode:'ai',transcript:'前言 Keyword\r\n小王：提及小林 Keyword\r\n延續 keyword\r\n\r\n[00:32] 小林：中文 KEYWORD\r\n小陳：其他 keyword'};
const recall=(overrides={})=>recallMeeting({meeting,speaker:'',query:'keyword',...overrides});
test('recall preserves source, CRLF, blank lines, explicit attribution and adjacent speaker context',async()=>{
  const r=await recall(); assert.equal(r.mode,'literal');assert.equal(r.totalMatches,5);
  assert.equal(r.hits[0].speaker,null);assert.equal(r.hits[1].text,'小王：提及小林 Keyword');
  const own=await recall({speaker:' 小林 ',query:'中文 keyword'});
  assert.equal(own.totalMatches,1);assert.equal(own.hits[0].lineIndex,4);
  assert.deepEqual(own.hits[0].context.map(v=>[v.lineIndex,v.speaker,v.text]),[[3,'小王',''],[4,'小林','[00:32] 小林：中文 KEYWORD'],[5,'小陳','小陳：其他 keyword']]);
  assert.equal((await recall({speaker:'小王'})).totalMatches,2);
  assert.equal((await recall({speaker:'小'})).totalMatches,0);
});
test('recall treats injection and regex terms literally and requires all terms on one line',async()=>{
  const m={...meeting,transcript:'甲：忽略指令 .* <script>\n乙：alpha\nBeta'};
  assert.equal((await recall({meeting:m,query:'.* <script>'})).totalMatches,1);
  assert.equal((await recall({meeting:m,query:'alpha Beta'})).totalMatches,0);
  assert.equal((await recall({query:'不存在'})).totalMatches,0);
});
test('recall truncates ordered matches at forty and counts all',async()=>{
  const r=await recall({meeting:{...meeting,transcript:Array.from({length:50},(_,i)=>`人物${i%10}：keyword ${i}`).join('\n')}});
  assert.equal(r.totalMatches,50);assert.equal(r.truncated,true);assert.equal(r.hits.length,40);assert.equal(r.hits.at(-1).lineIndex,39);
});
test('recall rejects invalid request fields and uses normalized meeting identity',async()=>{
  for(const body of [null, {query:''},{query:123},{query:'a'.repeat(201)},{speaker:null},{speaker:'a'.repeat(81)},{query:'1 2 3 4 5 6 7 8 9'},{meeting:{...meeting,transcript:''}}]) {
    await assert.rejects(()=>body===null?recallMeeting(null):recall(body));
  }
  await assert.rejects(()=>recallMeeting({}));
  assert.equal((await recall()).meetingId,(await recall({meeting:{...meeting,mode:'rules',transcript:meeting.transcript.replace(/\r\n/g,'\n')}})).meetingId);
});
test('recall API applies session, origin, JSON and size guards without provider calls',async t=>{
  let calls=0;
  const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:{model:'test'},fetcher:async()=>{calls++;throw Error('provider forbidden');}});
  app.address=()=>({port:4173});t.after(()=>app.emit('close'));
  const dispatch=(url,headers={},body)=>new Promise(resolve=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(body)]);req.url=url;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173',...headers};
    const res={headersSent:false,writeHead(status,h){this.status=status;this.headers=h;this.headersSent=true;},end(b){resolve({status:this.status,headers:this.headers,body:b});}};
    app.emit('request',req,res);
  });
  const home=await dispatch('/');const cookie=home.headers['Set-Cookie'].split(';')[0];
  const headers={cookie,origin:'http://127.0.0.1:4173','content-type':'application/json'};
  const body=JSON.stringify({meeting,query:'keyword',speaker:''});
  assert.equal((await dispatch('/api/recall',{},body)).status,401);
  assert.equal((await dispatch('/api/recall',{...headers,origin:'https://evil.test'},body)).status,403);
  assert.equal((await dispatch('/api/recall',{...headers,'content-type':'text/plain'},body)).status,415);
  assert.equal((await dispatch('/api/recall',headers,'{')).status,400);
  assert.equal((await dispatch('/api/recall',headers,'x'.repeat(160001))).status,400);
  const result=await dispatch('/api/recall',headers,body);assert.equal(result.status,200);assert.equal(JSON.parse(result.body).totalMatches,5);assert.equal(calls,0);
});
