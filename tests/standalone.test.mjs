// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApplication } from '../standalone/server.mjs';
const meeting={title:'分校營運週會',meetingDate:'2026-10-31',transcript:'小林：我會在 2026-11-03 前整理試聽學生名單。\n小陳：我會明天提交家長說明會簡報。\n主任：也許可以調整收費方案。',mode:'rules'};
const config={model:'gpt-4o-mini',notionToken:'test-only-token-never-real',dataSourceId:'test-source'};
const properties={任務:{type:'title'},'來源 ID':{type:'rich_text'},負責人:{type:'rich_text'},截止日期:{type:'date'}};
async function fixture(t,{live=false}={}) {
  const pages=new Map();let creates=0;
  const fetcher=async(url,init)=> {
    if(url.includes('/data_sources/')&&!url.endsWith('/query'))return Response.json({properties,title:[{plain_text:'測試任務表'}]});
    if(url.endsWith('/query')) { const key=JSON.parse(init.body).filter.rich_text.equals;return Response.json({results:pages.has(key)?[pages.get(key)]:[]}); }
    if(url.endsWith('/pages')) { creates++;const key=JSON.parse(init.body).properties['來源 ID'].rich_text[0].text.content;const page={id:`test-page-${creates}`,url:`https://app.notion.com/p/test-page-${creates}`};pages.set(key,page);return Response.json(page); }
    throw new Error('Unexpected external URL');
  };
  const app=createApplication({requireAccountAuth:false,config:live?config:{model:'test-no-provider'},databasePath:':memory:',fetcher});
  // Exercise the real Node request handler without opening sockets.
  // Browser and real HTTP transport still require a permitted preview environment.
  app.address=()=>({port:4173,address:'127.0.0.1',family:'IPv4'});
  t.after(()=>app.emit('close'));
  const origin='http://127.0.0.1:4173';
  const dispatch=(input,init={})=>new Promise(resolve=>{
    const url=new URL(input);
    const req=Readable.from(init.body?[Buffer.from(init.body)]:[]);
    req.url=url.pathname+url.search;req.method=init.method||'GET';
    req.headers=Object.fromEntries(new Headers({Host:url.host,...init.headers}).entries());
    const res={headersSent:false,status:200,headers:{},writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},end(body){resolve(new Response(body??null,{status:this.status,headers:this.headers}));}};
    app.emit('request',req,res);
  });
  const home=await dispatch(origin);assert.equal(home.status,200);
  const cookie=home.headers.get('set-cookie').split(';')[0];
  const get=path=>dispatch(origin+path,{headers:{Cookie:cookie}});
  const post=(path,body,extra={})=>dispatch(origin+path,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  return {origin,cookie,get,post,dispatch,creates:()=>creates};
}
test('in-process local router serves UI, requires session and rejects foreign origins and hosts',async t=>{
  const f=await fixture(t);
  const anonymous=await f.dispatch(f.origin+'/api/status');assert.equal(anonymous.status,401);
  const status=await(await f.get('/api/status')).json();assert.equal(status.aiConfigured,false);assert.equal(status.notionConfigured,false);assert.equal(status.storageReady,true);
  assert.equal((await f.post('/api/extract',meeting,{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.dispatch(f.origin+'/api/status',{headers:{Host:'evil.example',Cookie:f.cookie}})).status,403);
  assert.equal((await f.get('/.dev.vars')).status,404);
});
test('local demo extracts actual input and refuses unconfigured AI or Notion without fake success',async t=>{
  const f=await fixture(t);
  const result=await(await f.post('/api/extract',meeting)).json();assert.equal(result.tasks.length,2);assert.equal(result.mode,'rules');assert.equal(result.tasks[1].dueDate,'2026-11-01');
  assert.ok(result.tasks.every(task=>meeting.transcript.includes(task.evidence)));
  assert.equal((await f.post('/api/extract',{...meeting,mode:'ai'})).status,503);
  assert.equal((await f.get('/api/notion')).status,503);
  assert.equal((await f.post('/api/sync',{meeting,meetingId:result.meetingId,tasks:result.tasks,approved:true})).status,503);
});
test('in-process review-to-sync chain writes once per task with SQLite and mocked provider, rejects stale source',async t=>{
  const f=await fixture(t,{live:true});
  const status=await(await f.get('/api/status')).json();assert.equal(status.notionConfigured,true);assert.ok(!JSON.stringify(status).includes(config.notionToken));
  const connection=await(await f.get('/api/notion')).json();assert.equal(connection.targetName,'測試任務表');
  const extraction=await(await f.post('/api/extract',meeting)).json();
  const body={meeting,meetingId:extraction.meetingId,tasks:extraction.tasks,approved:true};
  assert.equal((await f.post('/api/sync',{...body,approved:false})).status,400);
  assert.equal((await f.post('/api/sync',{...body,meeting:{...meeting,transcript:meeting.transcript+'\n新增內容'}})).status,400);
  const first=await(await f.post('/api/sync',body)).json();assert.ok(first.results.every(r=>r.status==='created'));assert.equal(f.creates(),2);
  const second=await(await f.post('/api/sync',{...body,tasks:body.tasks.map(task=>({...task,title:'審閱後改名'}))})).json();assert.ok(second.results.every(r=>r.status==='existing'));assert.equal(f.creates(),2);
});
test('in-process API validates JSON body, transcript limits and source evidence before external writes',async t=>{
  const f=await fixture(t,{live:true});
  assert.equal((await f.post('/api/extract',{...meeting,transcript:'a'.repeat(45001)})).status,400);
  const raw=await f.dispatch(f.origin+'/api/extract',{method:'POST',headers:{Cookie:f.cookie,Origin:f.origin,'Content-Type':'application/json'},body:'{broken'});assert.equal(raw.status,400);
  const extracted=await(await f.post('/api/extract',meeting)).json();
  const bad=await f.post('/api/sync',{meeting,meetingId:extracted.meetingId,tasks:[{...extracted.tasks[0],evidence:'捏造的原文'}],approved:true});assert.equal(bad.status,400);assert.equal(f.creates(),0);
});
test('in-process reconcile-only endpoint never creates an unrecorded task',async t=>{
  const f=await fixture(t,{live:true});
  const extraction=await(await f.post('/api/extract',meeting)).json();
  const result=await(await f.post('/api/sync',{meeting,meetingId:extraction.meetingId,tasks:extraction.tasks,approved:true,reconcileOnly:true})).json();
  assert.ok(result.results.every(r=>r.status==='uncertain'));assert.equal(f.creates(),0);
  const normal=await(await f.post('/api/sync',{meeting,meetingId:extraction.meetingId,tasks:extraction.tasks,approved:true})).json();
  assert.ok(normal.results.every(r=>r.status==='created'));assert.equal(f.creates(),2);
});
