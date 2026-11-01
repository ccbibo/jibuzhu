import test from 'node:test';
import assert from 'node:assert/strict';
import {syncTasks} from '../lib/server-sync.ts';
import {extractRules} from '../lib/task-engine.ts';
const meeting={title:'週會',meetingDate:'2026-10-31',transcript:'小美：我會明天提交報表。',mode:'rules'};
const config={model:'test',notionToken:'fake',dataSourceId:'test-source'};
const schema={titleName:'任務',targetName:'任務表',properties:{任務:{type:'title'},'來源 ID':{type:'rich_text'}}};
function memoryStore(){
  const rows=new Map();
  return {rows,get:async(k,u)=>{const r=rows.get(k);return r?.user===u?r:null;},claim:async(k,u)=>{if(rows.has(k) && !(rows.get(k).user===u && rows.get(k).state==='failed'))return false;rows.set(k,{user:u,state:'pending'});return true;},finish:async(k,u,state,page)=>{assert.equal(rows.get(k)?.user,u);rows.set(k,{user:u,state,notion_page_id:page?.id??null,notion_url:page?.url??null});}};
}
test('successful repeat submission creates one remote page and returns existing receipt',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();let creates=0,queries=0;
  const fetcher=async(url)=>{if(url.endsWith('/query')){queries++;return Response.json({results:[]});}creates++;return Response.json({id:'page-1',url:'https://app.notion.com/p/page-1'});};
  const first=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  const second=await syncTasks('user-a',meeting,[{...tasks[0],title:'審閱後修改名稱'}],config,schema,store,fetcher);
  assert.equal(first.results[0].status,'created');assert.equal(second.results[0].status,'existing');assert.equal(creates,1);assert.equal(queries,1);
});
test('concurrent submissions atomically claim one write',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();let creates=0;const waiting=[];
  const fetcher=async(url)=>{if(url.endsWith('/query'))return new Promise(resolve=>{waiting.push(()=>resolve(Response.json({results:[]})));if(waiting.length===2)waiting.forEach(done=>done());});creates++;return Response.json({id:'page-1',url:'https://app.notion.com/p/page-1'});};
  const all=await Promise.all([syncTasks('user-a',meeting,tasks,config,schema,store,fetcher),syncTasks('user-a',meeting,tasks,config,schema,store,fetcher)]);
  assert.equal(creates,1);assert.ok(all.some(v=>v.results[0].status==='created'));assert.ok(all.some(v=>v.results[0].status==='uncertain'));
});
test('uncertain network result is not blindly retried; later query reconciles existing page',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();let creates=0,remoteExists=false;
  const fetcher=async(url)=>{if(url.endsWith('/query'))return Response.json({results:remoteExists?[{id:'page-eventually-created',url:'https://app.notion.com/p/found'}]:[]});creates++;throw new Error('connection lost after remote write');};
  const first=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  const second=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.equal(first.results[0].status,'uncertain');assert.equal(second.results[0].status,'uncertain');assert.equal(creates,1);
  remoteExists=true;
  const reconciled=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.equal(reconciled.results[0].status,'existing');assert.equal(creates,1);
});
test('query failure never sends remote write',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();let creates=0;
  const fetcher=async(url)=>{if(url.endsWith('/query'))return new Response('rate-limited',{status:429});creates++;return Response.json({id:'bad'});};
  const out=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.equal(out.results[0].status,'failed');assert.equal(creates,0);assert.equal(store.rows.size,0);
});
test('existing remote marker reconciles after receipt loss without creating again',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();let creates=0;
  const fetcher=async(url)=>{if(url.endsWith('/query'))return Response.json({results:[{id:'already-there',url:'https://app.notion.com/p/existing'}]});creates++;throw new Error('unexpected');};
  const out=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.equal(out.results[0].status,'existing');assert.equal(creates,0);assert.equal([...store.rows.values()][0].state,'success');
});
test('receipts and source markers are scoped by user and target',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();const markers=[];
  const fetcher=async(url,init)=>{if(url.endsWith('/query')){markers.push(JSON.parse(init.body).filter.rich_text.equals);return Response.json({results:[]});}return Response.json({id:'page',url:'https://app.notion.com/p/page'});};
  await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  await syncTasks('user-b',meeting,tasks,config,schema,store,fetcher);
  await syncTasks('user-a',meeting,tasks,{...config,dataSourceId:'another'},schema,store,fetcher);
  assert.equal(new Set(markers).size,3);assert.equal(store.rows.size,3);
});
test('explicit 400 rejection releases the receipt for a reviewed retry',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();let creates=0,shouldReject=true;
  const fetcher=async(url)=>{if(url.endsWith('/query'))return Response.json({results:[]});creates++;return shouldReject?new Response('invalid property',{status:400}):Response.json({id:'valid-page'});};
  const failed=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.equal(failed.results[0].status,'failed');assert.equal([...store.rows.values()][0].state,'failed');
  shouldReject=false;
  const retry=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.equal(retry.results[0].status,'created');assert.equal(creates,2);
});
test('429 stops the batch, preserves Retry-After, and allows explicit retry',async()=>{
  const {tasks}=await extractRules({...meeting,transcript:meeting.transcript+'\n小華：我會明天整理名單。'}),store=memoryStore();let calls=0,shouldLimit=true;
  const fetcher=async(url)=>{calls++;if(url.endsWith('/query'))return Response.json({results:[]});return shouldLimit?new Response('rate limited',{status:429,headers:{'Retry-After':'30'}}):Response.json({id:'created-'+calls});};
  const limited=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.equal(calls,2);assert.equal(limited.retryAfter,'30');assert.deepEqual(limited.results.map(v=>v.status),['failed','failed']);assert.match(limited.results[1].message,/尚未送出/);
  assert.equal([...store.rows.values()][0].state,'failed');assert.equal(store.rows.size,1);
  shouldLimit=false;
  const retried=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.deepEqual(retried.results.map(v=>v.status),['created','created']);
});
test('529 stops remaining remote requests but uncertain receipt cannot be reclaimed',async()=>{
  const {tasks}=await extractRules({...meeting,transcript:meeting.transcript+'\n小華：我會明天整理名單。'}),store=memoryStore();let calls=0;
  const fetcher=async(url)=>{calls++;return url.endsWith('/query')?Response.json({results:[]}):new Response('overload',{status:529,headers:{'Retry-After':'10'}});};
  const limited=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.equal(calls,2);assert.equal(limited.retryAfter,'10');assert.deepEqual(limited.results.map(v=>v.status),['uncertain','failed']);assert.equal([...store.rows.values()][0].state,'uncertain');
  assert.equal(await store.claim([...store.rows.keys()][0],'user-a'),false);
});
test('concurrent retries of a definitely failed receipt still create one page',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();
  await syncTasks('user-a',meeting,tasks,config,schema,store,async(url)=>url.endsWith('/query')?Response.json({results:[]}):new Response('bad',{status:400}));
  let creates=0;const waiting=[];
  const fetcher=async(url)=>{if(url.endsWith('/query'))return new Promise(resolve=>{waiting.push(()=>resolve(Response.json({results:[]})));if(waiting.length===2)waiting.forEach(done=>done());});creates++;return Response.json({id:'created-once'});};
  const all=await Promise.all([syncTasks('user-a',meeting,tasks,config,schema,store,fetcher),syncTasks('user-a',meeting,tasks,config,schema,store,fetcher)]);
  assert.equal(creates,1);assert.equal(all.filter(v=>v.results[0].status==='created').length,1);
});
test('HTTP 503 write response stays uncertain and cannot trigger a second creation',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();let creates=0;
  const fetcher=async(url)=>{if(url.endsWith('/query'))return Response.json({results:[]});creates++;return new Response('internal remote details',{status:503});};
  const first=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  const second=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher);
  assert.equal(first.results[0].status,'uncertain');assert.equal(second.results[0].status,'uncertain');assert.equal(creates,1);
});
test('reconcile-only never claims or creates when receipt is lost and no remote marker is found',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();let queries=0,claims=0,creates=0;
  const originalClaim=store.claim;store.claim=async(...args)=>{claims++;return originalClaim(...args);};
  const fetcher=async(url)=>{if(url.endsWith('/query')){queries++;return Response.json({results:[]});}creates++;return Response.json({id:'must-not-create'});};
  const result=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher,true);
  assert.equal(result.results[0].status,'uncertain');assert.equal(queries,1);assert.equal(claims,0);assert.equal(creates,0);assert.equal(store.rows.size,0);
});
test('reconcile-only can return an existing remote page after receipt loss without creating any claim',async()=>{
  const {tasks}=await extractRules(meeting),store=memoryStore();let queries=0;
  store.claim=async()=>{throw new Error('must not claim in reconcile-only');};
  const fetcher=async(url)=>{assert.ok(url.endsWith('/query'));queries++;return Response.json({results:[{id:'already-there',url:'https://app.notion.com/p/existing'}]});};
  const result=await syncTasks('user-a',meeting,tasks,config,schema,store,fetcher,true);
  assert.equal(result.results[0].status,'existing');assert.equal(queries,1);assert.equal(store.rows.size,0);
});
