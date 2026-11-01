// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApplication } from '../standalone/server.mjs';

// Real application handler, synthetic request/response and in-memory SQLite.
// These tests do not open an HTTP socket, launch a browser or contact providers.
const meeting = transcript => ({ title:'回找契約合成案例', meetingDate:'2026-10-31', transcript, mode:'ai' });
async function fixture(t) {
  let externalCalls=0;
  const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:{model:'test-only',openaiKey:'mock-key',notionToken:'mock-token',dataSourceId:'mock-source'},fetcher:async()=>{externalCalls++;throw new Error('Recall must never contact a provider');}});
  app.address=()=>({port:4173,address:'127.0.0.1',family:'IPv4'});
  t.after(()=>app.emit('close'));
  const origin='http://127.0.0.1:4173';
  const dispatch=(route,init={})=>new Promise(resolve=>{
    const req=Readable.from(init.body===undefined?[]:[Buffer.from(init.body)]);
    req.url=route; req.method=init.method||'GET';
    req.headers=Object.fromEntries(new Headers({Host:'127.0.0.1:4173',...init.headers}).entries());
    const res={headersSent:false,status:200,headers:{},writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},end(body){resolve(new Response(body??null,{status:this.status,headers:this.headers}));}};
    app.emit('request',req,res);
  });
  const home=await dispatch('/'); assert.equal(home.status,200);
  const cookie=home.headers.get('set-cookie').split(';')[0];
  const post=(body,headers={})=>dispatch('/api/recall',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const recall=async(transcript,query,speaker='')=>{
    const response=await post({meeting:meeting(transcript),query,speaker});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  return {dispatch,post,recall,cookie,origin,externalCalls:()=>externalCalls};
}

test('recall API separates actual speakers, mentions, timestamp labels and continuation lines',async t=>{
  const f=await fixture(t);
  const lines=['無人物：以外的前言請見下一案','[09:00] 小林：請小陳確認預算 RAG','  延續預算 rag  ','','小陳：預算 RAG 已收到','小林：預算只有一詞'];
  // A plain unlabelled opening is explicitly speaker=null.
  lines[0]='前言預算 RAG 尚未標人物';
  const result=await f.recall(lines.join('\r\n'),'  預算 RAG  ','  小林  ');
  assert.equal(result.mode,'literal'); assert.equal(result.query,'預算 RAG'); assert.equal(result.speaker,'小林');
  assert.equal(typeof result.meetingId,'string'); assert.ok(result.meetingId.length>0);
  assert.equal(typeof result.notice,'string'); assert.ok(result.notice.length>0);
  assert.equal(result.totalMatches,2); assert.equal(result.truncated,false);
  assert.deepEqual(result.hits.map(h=>h.lineIndex),[1,2]);
  assert.equal(result.hits[1].text,'  延續預算 rag  ');
  assert.deepEqual(result.hits[0].context,[{lineIndex:0,text:lines[0],speaker:null},{lineIndex:1,text:lines[1],speaker:'小林'},{lineIndex:2,text:lines[2],speaker:'小林'}]);
  const mentioned=await f.recall(lines.join('\n'),'預算 RAG','小陳');
  assert.deepEqual(mentioned.hits.map(h=>h.lineIndex),[4]);
  const all=await f.recall(lines.join('\n'),'預算 rag');
  assert.equal(all.hits[0].speaker,null);
  const blank=await f.recall('小林：預算\n\nRAG 預算','RAG 預算','小林');
  assert.equal(blank.hits[0].speaker,'小林');
  assert.deepEqual(blank.hits[0].context.map(c=>c.lineIndex),[1,2]);
  assert.equal(blank.hits[0].context[0].text,'');
  assert.equal(blank.hits[0].context[0].speaker,'小林');
  assert.equal(f.externalCalls(),0);
});

test('recall API treats terms as literal AND on each line and preserves injection text',async t=>{
  const f=await fixture(t);
  const payload='<img src=x onerror=alert(1)>';
  const text=`甲：預算\n乙：RAG\n甲：預算 rag ${payload} a.* [x]\n乙：預算 RAG abcd x`;
  const result=await f.recall(text,'預算 RAG');
  assert.deepEqual(result.hits.map(h=>h.lineIndex),[2,3]);
  assert.deepEqual((await f.recall(text,'a.* [x]')).hits.map(h=>h.lineIndex),[2]);
  assert.equal((await f.recall(text,payload)).hits[0].text,`甲：預算 rag ${payload} a.* [x]`);
  const none=await f.recall(text,'從未出現');
  assert.equal(none.totalMatches,0);assert.deepEqual(none.hits,[]);assert.equal(none.truncated,false);
  assert.equal(f.externalCalls(),0);
});

test('recall API returns first 40 ordered matches with full count and adjacent mixed-speaker context',async t=>{
  const f=await fixture(t);
  const lines=Array.from({length:45},(_,i)=>`${i%2?'乙':'甲'}：預算 ${i}`);
  const result=await f.recall(lines.join('\n'),'預算');
  assert.equal(result.totalMatches,45);assert.equal(result.hits.length,40);assert.equal(result.truncated,true);
  assert.deepEqual(result.hits.map(h=>h.lineIndex),Array.from({length:40},(_,i)=>i));
  assert.deepEqual(result.hits[0].context.map(c=>c.speaker),['甲','乙']);
  assert.deepEqual(result.hits[39].context.map(c=>c.lineIndex),[38,39,40]);
  const exactly=await f.recall(lines.slice(0,40).join('\n'),'預算');assert.equal(exactly.truncated,false);
});

test('recall API rejects invalid inputs and accepts trimmed boundary inputs',async t=>{
  const f=await fixture(t), valid={meeting:meeting('甲：預算'),speaker:'',query:'預算'};
  for(const query of ['', '   ',null,7,{},'x'.repeat(201),'a b c d e f g h i']) assert.equal((await f.post({...valid,query})).status,400,`query ${JSON.stringify(query)}`);
  for(const speaker of [null,3,{},'x'.repeat(81)]) assert.equal((await f.post({...valid,speaker})).status,400,`speaker ${JSON.stringify(speaker)}`);
  for(const invalidMeeting of [null,{}, {...valid.meeting,transcript:''},{...valid.meeting,transcript:'x'.repeat(45001)},{...valid.meeting,meetingDate:'2026-02-30'}]) assert.equal((await f.post({...valid,meeting:invalidMeeting})).status,400);
  for(const body of [null,[],{}]) assert.equal((await f.post(body)).status,400);
  assert.equal((await f.post({...valid,query:'  '+'x'.repeat(200)+'  ',speaker:'  '+'甲'.repeat(80)+'  '})).status,200);
  assert.equal((await f.post({...valid,query:'a b c d e f g h'})).status,200);
});

test('recall API preserves session, same-origin, host, JSON and size restrictions',async t=>{
  const f=await fixture(t),body={meeting:meeting('甲：預算'),speaker:'',query:'預算'};
  assert.equal((await f.post(body,{Cookie:''})).status,401);
  assert.equal((await f.post(body,{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.post(body,{Origin:''})).status,403);
  assert.equal((await f.post(body,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await f.post(body,{Host:'evil.example'})).status,403);
  assert.equal((await f.post(body,{'Content-Type':'text/plain'})).status,415);
  const headers={Cookie:f.cookie,Origin:f.origin,'Content-Type':'application/json'};
  assert.equal((await f.dispatch('/api/recall',{method:'POST',headers,body:'{broken'})).status,400);
  assert.equal((await f.dispatch('/api/recall',{method:'POST',headers,body:JSON.stringify({...body,padding:'x'.repeat(160001)})})).status,400);
  assert.equal((await f.dispatch('/api/recall',{headers:{Cookie:f.cookie}})).status,404);
  assert.equal(f.externalCalls(),0);
});
