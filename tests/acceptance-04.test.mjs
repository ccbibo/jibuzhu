// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApplication } from '../standalone/server.mjs';

// Tester-owned remote simulation. It persists and serves actual mutated JSON; it
// does not import notionPayload or verifyTasks to compute its expected answers.
const meeting={title:'tester04 讀回試驗',meetingDate:'2026-10-31',mode:'rules',transcript:'小芸：我會明天提交期末報告。'};
const rich=s=>[{type:'text',text:{content:s}}];
async function fixture(t){
 const calls=[];let page=null,duplicate=false,breakTail=false,denyRead=false;
 const config={model:'tester04',notionToken:'synthetic-only-token',dataSourceId:'tester04-source'};
 const fetcher=async(url,init={})=>{
  const method=init.method??'GET';calls.push({url,method,body:init.body});
  if(url==='https://api.notion.com/v1/data_sources/tester04-source')return Response.json({title:rich('合成測試表'),properties:{任務:{type:'title'},'來源 ID':{type:'rich_text'},負責人:{type:'rich_text'},截止日期:{type:'date'},優先級:{type:'select'}}});
  if(url.endsWith('/query')){
   assert.equal(method,'POST');assert.equal(JSON.parse(init.body).filter.rich_text.equals,page?.properties['來源 ID'].rich_text.map(p=>p.text.content).join('')??JSON.parse(init.body).filter.rich_text.equals);
   return Response.json({results:page?[{id:page.id},...(duplicate?[{id:'other-page'}]:[])]:[],has_more:false});
  }
  if(url==='https://api.notion.com/v1/pages'&&method==='POST'){
   assert.equal(page,null,'must never create a second page');const p=JSON.parse(init.body);
   const properties=structuredClone(p.properties);for(const v of Object.values(properties)){v.type=Object.keys(v)[0];if(v.date)v.date={...v.date,end:null,time_zone:null};}
   page={id:'tester04-page',url:'https://www.notion.so/tester04-page',archived:false,in_trash:false,parent:p.parent,properties,blocks:p.children};
   return Response.json({id:page.id,url:page.url});
  }
  assert.equal(method,'GET','readback must never PATCH, DELETE or create');
  if(denyRead)return new Response('synthetic token must not leak',{status:403});
  if(url==='https://api.notion.com/v1/pages/tester04-page')return Response.json(page);
  if(url.includes('/blocks/tester04-page/children?')){
   const cursor=new URL(url).searchParams.get('start_cursor');
   if(cursor==='tail'&&breakTail)return Response.json({results:[],has_more:true,next_cursor:'tail'});
   const [start,end,next]=cursor===null?[0,1,'middle']:cursor==='middle'?[1,3,'tail']:[3,4,null];
   return Response.json({results:page.blocks.slice(start,end),has_more:next!==null,next_cursor:next});
  }
  assert.fail('unexpected remote request '+url);
 };
 const app=createApplication({requireAccountAuth:false,config,databasePath:':memory:',fetcher});app.address=()=>({port:4173});t.after(()=>app.emit('close'));
 const dispatch=async(route,body,extra={})=>new Promise(resolve=>{
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url=route;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173',...(body===undefined?{}:{cookie,origin:'http://127.0.0.1:4173','content-type':'application/json'}),...extra};
  const res={headersSent:false,writeHead(status,h){this.status=status;this.headers=h;this.headersSent=true;},end(body){resolve({status:this.status,headers:this.headers,body:JSON.parse(this.headers['Content-Type'].includes('json')?body:'{}')});}};app.emit('request',req,res);
 });
 let cookie;cookie=(await dispatch('/')).headers['Set-Cookie'].split(';')[0];
 const extracted=(await dispatch('/api/extract',meeting)).body;
 assert.equal(extracted.tasks.length,1);
 const task={...extracted.tasks[0],title:'人工確認：提交期末報告',assignee:'小芸',dueDate:'2026-11-01',priority:'high',warnings:['tester04 人工確認']};
 const body={meeting,meetingId:extracted.meetingId,tasks:[task],approved:true};
 const sync=()=>dispatch('/api/sync',body),verify=()=>dispatch('/api/verify',body);
 return {calls,task,body,dispatch,sync,verify,page:()=>page,duplicate:()=>{duplicate=true;},breakTail:()=>{breakTail=true;},denyRead:()=>{denyRead=true;}};
}
async function created(f){const r=await f.sync();assert.equal(r.status,200);assert.equal(r.body.results[0].status,'created');}
const onlyReads=calls=>{for(const c of calls)assert.ok(c.method==='GET'||(c.method==='POST'&&c.url.endsWith('/query')),JSON.stringify(c));};
test('04 route locates remote page independently; missing is not success and does not create',async t=>{
 const f=await fixture(t),n=f.calls.length,r=await f.verify();assert.equal(r.status,200);assert.equal(r.body.results[0].status,'missing');assert.equal(f.page(),null);onlyReads(f.calls.slice(n));
});
test('04 created receipt cannot replace three-page readback and all reviewed fields',async t=>{
 const f=await fixture(t);await created(f);const p=f.page();
 assert.equal(p.properties.任務.title.map(x=>x.text.content).join(''),f.task.title);assert.equal(p.properties.負責人.rich_text[0].text.content,'小芸');assert.equal(p.properties.截止日期.date.start,'2026-11-01');assert.equal(p.properties.優先級.select.name,'高');
 assert.match(p.blocks[0].paragraph.rich_text[0].text.content,/tester04 讀回試驗/);assert.match(p.blocks[1].paragraph.rich_text[0].text.content,/第 1 行/);assert.match(p.blocks[1].paragraph.rich_text[0].text.content,/我會明天提交期末報告/);
 const n=f.calls.length,r=await f.verify();assert.equal(r.body.results[0].status,'verified');onlyReads(f.calls.slice(n));assert.equal(f.calls.slice(n).filter(c=>c.url.includes('/children?')).length,3);assert.ok(f.calls.slice(n).some(c=>c.url.endsWith('start_cursor=tail')));
});
test('04 corrupt remote fields after created/existing receipt never verify',async t=>{
 for(const [field,mutate] of [
  ['title',p=>p.properties.任務.title=rich('錯誤標題')],['owner',p=>p.properties.負責人.rich_text=rich('他人')],['date',p=>p.properties.截止日期.date.start='2026-11-03'],['priority',p=>p.properties.優先級.select.name='低'],
  ['meeting',p=>p.blocks[0].paragraph.rich_text=rich('錯誤會議')],['evidence',p=>p.blocks[1].paragraph.rich_text=rich('原文依據（第 9 行）：杜撰')],['final-page source',p=>p.blocks[3].paragraph.rich_text=rich('偽造來源 ID')],
  ['archived',p=>p.archived=true],['wrong-parent',p=>p.parent.data_source_id='other-source']]){
  await t.test(field,async st=>{const f=await fixture(st);await created(f);mutate(f.page());assert.equal((await f.sync()).body.results[0].status,'existing');const n=f.calls.length,r=await f.verify();assert.equal(r.body.results[0].status,'mismatch',JSON.stringify(r));assert.ok(r.body.results[0].differences.length);onlyReads(f.calls.slice(n));});
 }
});
test('04 duplicate source ID refuses first-result shortcut before page reads',async t=>{
 const f=await fixture(t);await created(f);f.duplicate();const n=f.calls.length,r=await f.verify();assert.equal(r.body.results[0].status,'mismatch');assert.match(r.body.results[0].differences.join(),/重複/);assert.equal(f.calls.slice(n).filter(c=>c.url.includes('/pages/')).length,0);onlyReads(f.calls.slice(n));
});
test('04 incomplete pagination and forbidden read fail without rewriting saved page',async t=>{
 for(const mode of ['breakTail','denyRead'])await t.test(mode,async st=>{const f=await fixture(st);await created(f);f[mode]();const n=f.calls.length,r=await f.verify();assert.equal(r.status,200);assert.equal(r.body.results[0].status,'failed');onlyReads(f.calls.slice(n));assert.equal(JSON.stringify(r).includes('synthetic-only-token'),false);});
});
test('04 review approval and meeting identity rejected before remote read',async t=>{
 const f=await fixture(t);for(const body of [{...f.body,approved:false},{...f.body,meetingId:'stale'}]){const n=f.calls.length;assert.equal((await f.dispatch('/api/verify',body)).status,400);assert.equal(f.calls.length,n);}
});
