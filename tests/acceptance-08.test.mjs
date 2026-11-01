import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sqliteStore } from '../standalone/server.mjs';
import { syncTasks } from '../lib/server-sync.ts';
import { verifyTasks } from '../lib/notion-verify.ts';
import { digest } from '../lib/task-engine.ts';

const meeting={title:'獨立韌性測試',meetingDate:'2026-10-31',transcript:'小美：我會明天提交報表。',mode:'rules'};
const task={id:'synthetic-task-08',title:'提交報表',assignee:'小美',dueDate:'2026-11-01',dueText:'明天',priority:'normal',evidence:meeting.transcript,lineIndex:0,warnings:[]};
const config={model:'synthetic',notionToken:'FAKE-08-NOT-A-CREDENTIAL',dataSourceId:'synthetic-source-08'};
const schema={titleName:'任務',targetName:'模擬表',properties:{任務:{type:'title'},'來源 ID':{type:'rich_text'}}};
const key=()=>digest(`tester08\n${config.dataSourceId}\n${task.id}`);
function openDb(file=':memory:') {
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS sync_receipts (key TEXT PRIMARY KEY,user_id TEXT NOT NULL,state TEXT NOT NULL,notion_page_id TEXT,notion_url TEXT,updated_at INTEGER NOT NULL)');
  return db;
}
const empty=()=>Response.json({results:[],has_more:false});
const run=(store,fetcher,tasks=[task],reconcileOnly=false)=>syncTasks('tester08',meeting,tasks,config,schema,store,fetcher,reconcileOnly);

test('08 SQLite receipts survive close/reopen and prevent a second remote call',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'tester08-')),file=path.join(dir,'receipts.sqlite');let db=openDb(file),calls=0;
  const fetcher=async url=>{calls++;return url.endsWith('/query')?empty():Response.json({id:'page08',url:'https://www.notion.so/page08'});};
  try {
    assert.equal((await run(sqliteStore(db),fetcher)).results[0].status,'created');db.close();db=openDb(file);
    const result=await run(sqliteStore(db),fetcher);
    assert.equal(result.results[0].status,'existing');assert.equal(calls,2);
    assert.equal((await sqliteStore(db).get(await key(),'tester08')).notion_page_id,'page08');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('08 independent SQLite connections atomically claim one concurrent write',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'tester08-')),file=path.join(dir,'receipts.sqlite'),a=openDb(file),b=openDb(file);let writes=0;const pending=[];
  const fetcher=async url=>{if(url.endsWith('/query'))return new Promise(resolve=>{pending.push(resolve);if(pending.length===2)pending.forEach(done=>done(empty()));});writes++;return Response.json({id:'one-page'});};
  try {const results=await Promise.all([run(sqliteStore(a),fetcher),run(sqliteStore(b),fetcher)]);assert.equal(writes,1);assert.deepEqual(results.map(r=>r.results[0].status).sort(),['created','uncertain']);}
  finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('08 success receipt persistence failure remains uncertain and query-only reconciliation never recreates',async()=>{
  const db=openDb(),base=sqliteStore(db);let writes=0,queries=0,found=false;
  const store={...base,finish:async(...args)=>{if(args[2]==='success')throw Error('simulated disk failure');return base.finish(...args);}};
  const fetcher=async url=>{if(url.endsWith('/query')){queries++;return Response.json({results:found?[{id:'remote-page'}]:[],has_more:false});}writes++;return Response.json({id:'remote-page'});};
  try {
    assert.equal((await run(store,fetcher)).results[0].status,'uncertain');
    assert.equal((await base.get(await key(),'tester08')).state,'uncertain');
    assert.equal((await run(base,fetcher)).results[0].status,'uncertain');
    found=true;assert.equal((await run(base,fetcher,[task],true)).results[0].status,'existing');
    assert.equal(writes,1);assert.equal(queries,3);assert.equal((await base.get(await key(),'tester08')).state,'success');
  }finally{db.close();}
});

test('08 only failed own receipt retries; distinct accounts independently claim the same key',async()=>{
  const db=openDb(),store=sqliteStore(db);
  try {for(const state of ['pending','uncertain','success','failed']){const k=`state-${state}`;assert.equal(await store.claim(k,'tester08'),true);await store.finish(k,'tester08',state);assert.equal(await store.claim(k,'other-account'),true);assert.equal((await store.get(k,'tester08')).state,state);assert.equal((await store.get(k,'other-account')).state,'pending');assert.equal(await store.claim(k,'tester08'),state==='failed');}}
  finally{db.close();}
});

test('08 lost receipt reconciliation is read only even when remote marker is missing',async()=>{
  const db=openDb(),base=sqliteStore(db);let calls=0;
  const store={...base,claim:async()=>assert.fail('read-only must not claim'),finish:async()=>assert.fail('lost receipt must not be manufactured')};
  try{const out=await run(store,async url=>{calls++;assert.ok(url.endsWith('/query'));return empty();},[task],true);assert.equal(out.results[0].status,'uncertain');assert.equal(calls,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_receipts').get().n,0);}
  finally{db.close();}
});

test('08 write 529 preserves Retry-After, stops remaining calls, cannot blindly retry',async()=>{
  const db=openDb(),store=sqliteStore(db);let calls=0,writes=0;
  const fetcher=async url=>{calls++;if(url.endsWith('/query'))return empty();writes++;return new Response('sensitive-upstream',{status:529,headers:{'Retry-After':'17'}});};
  try {const out=await run(store,fetcher,[task,{...task,id:'second08'}]);assert.equal(out.retryAfter,'17');assert.equal(calls,2);assert.deepEqual(out.results.map(r=>r.status),['uncertain','failed']);assert.ok(!JSON.stringify(out).includes('sensitive-upstream'));await run(store,fetcher);assert.equal(writes,1);}
  finally{db.close();}
});

test('08 explicit 400 rejection can be reviewed and retried once',async()=>{
  const db=openDb(),store=sqliteStore(db);let writes=0;
  const fetcher=async url=>url.endsWith('/query')?empty():++writes===1?new Response('bad',{status:400}):Response.json({id:'retry-page'});
  try {assert.equal((await run(store,fetcher)).results[0].status,'failed');assert.equal((await store.get(await key(),'tester08')).state,'failed');assert.equal((await run(store,fetcher)).results[0].status,'created');assert.equal(writes,2);}
  finally{db.close();}
});

test('08 malformed dedup query must fail closed before any creation',async()=>{
  for(const payload of [{unexpected:true},{results:null,has_more:false},{results:[],has_more:true,next_cursor:'unread'},{results:[{id:'a'},{id:'b'}],has_more:false},{results:[{id:23}],has_more:false}]){
    const db=openDb(),store=sqliteStore(db);let writes=0;
    try {const out=await run(store,async url=>{if(url.endsWith('/query'))return Response.json(payload);writes++;return Response.json({id:'duplicate-risk'});});assert.equal(writes,0,`dedup failed open for ${JSON.stringify(payload)}`);assert.equal(out.results[0].status,'failed');}
    finally{db.close();}
  }
});

test('08 query 429 stops a batch without claiming or creating any receipt',async()=>{
  const db=openDb(),store=sqliteStore(db);let calls=0;
  try{const out=await run(store,async url=>{calls++;assert.ok(url.endsWith('/query'));return new Response('upstream-secret',{status:429,headers:{'Retry-After':'31'}});},[task,{...task,id:'second08'}]);assert.equal(calls,1);assert.equal(out.retryAfter,'31');assert.deepEqual(out.results.map(r=>r.status),['failed','failed']);assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_receipts').get().n,0);}
  finally{db.close();}
});

test('08 readback failure after locating a page makes no mutation or automatic rewrite',async()=>{
  const calls=[];
  const out=await verifyTasks('tester08',meeting,[task],config,schema,async(url,init)=>{calls.push({url,method:init.method});if(url.endsWith('/query'))return Response.json({results:[{id:'page08'}],has_more:false});assert.equal(init.method,'GET');return new Response('upstream-secret',{status:503});});
  assert.equal(out.results[0].status,'failed');assert.equal(calls.length,2);assert.ok(!JSON.stringify(out).includes('upstream-secret'));
});

test('08 independent verification failures and duplicate sources never rewrite',async()=>{
  for(const payload of [{results:[{id:'a'},{id:'b'}],has_more:false},{results:[],has_more:true},{results:[]}]){
    const calls=[];
    const out=await verifyTasks('tester08',meeting,[task],config,schema,async(url,init)=>{calls.push({url,method:init.method});assert.ok(url.endsWith('/query'));assert.equal(init.method,'POST');return Response.json(payload);});
    assert.ok(['mismatch','failed'].includes(out.results[0].status));assert.equal(calls.length,1);
  }
  const out=await verifyTasks('tester08',meeting,[task,{...task,id:'second08'}],config,schema,async(url,init)=>{assert.ok(url.endsWith('/query'));assert.equal(init.method,'POST');return new Response('FAKE-08-NOT-A-CREDENTIAL',{status:429,headers:{'Retry-After':'23'}});});
  assert.equal(out.retryAfter,'23');assert.deepEqual(out.results.map(r=>r.status),['failed','failed']);assert.ok(!JSON.stringify(out).includes(config.notionToken));
});
