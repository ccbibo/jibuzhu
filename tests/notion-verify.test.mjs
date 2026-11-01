import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTasks } from '../lib/notion-verify.ts';
import { notionPayload, ProviderError } from '../lib/providers.ts';
import { digest } from '../lib/task-engine.ts';
const config={model:'test',notionToken:'fake-secret',dataSourceId:'source'};
const schema={titleName:'任務',targetName:'任務表',properties:{任務:{type:'title'},'來源 ID':{type:'rich_text'},負責人:{type:'rich_text'},截止日期:{type:'date'},優先級:{type:'select'}}};
const meeting={title:'週會',meetingDate:'2026-10-31',transcript:'小美：我會明天提交報表。',mode:'rules'};
const task={id:'task-a',title:'審閱後報表',assignee:'小美',dueDate:'2026-11-01',dueText:'明天',priority:'high',evidence:meeting.transcript,lineIndex:0,warnings:['已確認']};
const rich=text=>[{type:'text',text:{content:text}}];
async function fixture(){
  const sourceId=`actiondesk:${await digest(`user\nsource\n${task.id}`)}`;
  const payload=notionPayload(config,schema,task,meeting,sourceId);
  const properties=structuredClone(payload.properties);
  for(const property of Object.values(properties)){
    property.type=Object.keys(property)[0];
    if(property.date)property.date={...property.date,end:null,time_zone:null};
  }
  const page={id:'page',url:'https://www.notion.so/page',parent:payload.parent,archived:false,in_trash:false,properties};
  const blocks=structuredClone(payload.children);
  const calls=[];
  let query={results:[{id:'page'}],has_more:false};
  let chunks=[{results:blocks,has_more:false,next_cursor:null}];
  const fetcher=async(url,init)=>{
    calls.push({url,method:init.method,body:init.body});
    assert.ok(init.method==='GET' || (init.method==='POST' && url.endsWith('/query')),'readback must never create, patch, or delete');
    if(url.endsWith('/query')){
      const body=JSON.parse(init.body);assert.equal(body.page_size,2);assert.equal(body.filter.rich_text.equals,sourceId);
      return Response.json(query);
    }
    if(url.includes('/children?')){
      const cursor=new URL(url).searchParams.get('start_cursor');
      return Response.json(chunks[cursor?Number(cursor):0]);
    }
    assert.equal(url,'https://api.notion.com/v1/pages/page');
    return Response.json(page);
  };
  return {page,blocks,calls,fetcher,setQuery:value=>{query=value;},setChunks:value=>{chunks=value;}};
}
const run=f=>verifyTasks('user',meeting,[task],config,schema,f.fetcher).then(r=>r.results[0]);
test('readback retrieves edited properties and all four source paragraphs across pagination, without creates',async()=>{
  const f=await fixture();
  f.setChunks([{results:f.blocks.slice(0,2),has_more:true,next_cursor:'1'},{results:f.blocks.slice(2),has_more:false,next_cursor:null}]);
  const out=await run(f);assert.equal(out.status,'verified');assert.deepEqual(out.differences,[]);
  assert.equal(f.calls.length,4);assert.match(f.calls[3].url,/start_cursor=1/);
});
test('matching source marker alone cannot verify a page',async()=>{
  const f=await fixture();f.page.properties.任務.title=rich('先前名稱');
  const out=await run(f);assert.equal(out.status,'mismatch');assert.match(out.differences.join(),/任務/);
});
for(const [name,modify,label] of [
  ['title',f=>{f.page.properties.任務.title=rich('old');},'任務'],
  ['owner',f=>{f.page.properties.負責人.rich_text=rich('其他人');},'負責人'],
  ['date',f=>{f.page.properties.截止日期.date.start='2026-11-02';},'截止日期'],
  ['date range',f=>{f.page.properties.截止日期.date.end='2026-11-02';},'截止日期'],
  ['priority',f=>{f.page.properties.優先級.select.name='低';},'優先級'],
  ['source ID',f=>{f.page.properties['來源 ID'].rich_text=rich('wrong');},'來源 ID'],
  ['meeting',f=>{f.blocks[0].paragraph.rich_text=rich('會議：wrong');},'會議與會議日期'],
  ['evidence',f=>{f.blocks[1].paragraph.rich_text=rich('different evidence');},'原文依據與行號'],
  ['line number',f=>{f.blocks[1].paragraph.rich_text=rich(`原文依據（第 2 行）：\n${task.evidence}`);},'原文依據與行號'],
  ['owner/date paragraph',f=>{f.blocks[2].paragraph.rich_text=rich('wrong');},'負責人與截止日期原文'],
  ['review/source paragraph',f=>{f.blocks[3].paragraph.rich_text=rich('wrong');},'審閱註記與來源 ID'],
  ['archived page',f=>{f.page.archived=true;},'封存'],
  ['trashed page',f=>{f.page.in_trash=true;},'垃圾桶'],
  ['wrong parent',f=>{f.page.parent.data_source_id='other';},'資料來源'],
  ['extra paragraph',f=>{f.blocks.push(f.blocks[0]);},'段落數量'],
  ['nested content',f=>{f.blocks[0].has_children=true;},'會議與會議日期'],
])test(`readback detects ${name} mismatch`,async()=>{const f=await fixture();modify(f);const out=await run(f);assert.equal(out.status,'mismatch');assert.ok(out.differences.some(d=>d.includes(label)));});
test('duplicate IDs and query has_more cannot return verified or select a first result',async()=>{
  for(const query of [{results:[{id:'page'},{id:'duplicate'}],has_more:false},{results:[{id:'page'}],has_more:true}]){
    const f=await fixture();f.setQuery(query);const out=await run(f);
    assert.equal(out.status,'mismatch');assert.match(out.differences.join(),/重複/);assert.equal(f.calls.length,1);
  }
});
test('absent source returns missing without writing or consulting any receipt',async()=>{
  const f=await fixture();f.setQuery({results:[],has_more:false});assert.equal((await run(f)).status,'missing');assert.equal(f.calls.length,1);
});
test('partial, malformed and cyclic pagination fail closed',async()=>{
  for(const chunks of [
    [{results:[],has_more:true,next_cursor:null}],
    [{results:[],has_more:true,next_cursor:'1'},{results:[],has_more:true,next_cursor:'1'}],
    [{results:[],has_more:true,next_cursor:'1'},{has_more:false}],
    [{results:[],next_cursor:null}],
    Array.from({length:21},(_,i)=>({results:[],has_more:true,next_cursor:String(i+1)})),
  ]){const f=await fixture();f.setChunks(chunks);assert.equal((await run(f)).status,'failed');assert.ok(f.calls.length<=22);}
});
test('malformed query/page/property/block response never passes verification',async()=>{
  for(const change of [
    f=>f.setQuery({results:[{id:'page'}]}),
    f=>{f.page.id='other';},
    f=>{f.page.properties.任務.title=[{type:'text',plain_text:task.title}];},
    f=>{f.blocks[0].paragraph.rich_text=null;},
  ]){const f=await fixture();change(f);assert.equal((await run(f)).status,'failed');}
});
test('unsafe readback URL is omitted',async()=>{
  const f=await fixture();f.page.url='javascript:alert(1)';const out=await run(f);assert.equal(out.status,'verified');assert.equal(out.url,undefined);
});
test('provider read failures do not create pages and do not leak upstream errors',async()=>{
  const out=await verifyTasks('user',meeting,[task],config,schema,async()=>{throw new Error('fake-secret');});
  assert.equal(out.results[0].status,'failed');assert.ok(!JSON.stringify(out).includes('fake-secret'));
});
test('rate limit stops remaining readback requests and preserves Retry-After',async()=>{
  let calls=0;const out=await verifyTasks('user',meeting,[task,{...task,id:'second'}],config,schema,async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'30'}});});
  assert.equal(calls,1);assert.equal(out.retryAfter,'30');assert.deepEqual(out.results.map(r=>r.status),['failed','failed']);
});
test('missing Notion credentials returns 503 before network',async()=>{
  for(const c of [{...config,notionToken:undefined},{...config,dataSourceId:undefined}])await assert.rejects(()=>verifyTasks('user',meeting,[task],c,schema,async()=>assert.fail('network must not run')),e=>e instanceof ProviderError && e.status===503);
});
test('optional absent fields and null owner/date can still be verified',async()=>{
  const minimal={titleName:'任務',targetName:'表',properties:{任務:{type:'title'},'來源 ID':{type:'rich_text'}}};
  const f=await fixture();for(const name of ['負責人','截止日期','優先級'])delete f.page.properties[name];
  assert.equal((await verifyTasks('user',meeting,[task],config,minimal,f.fetcher)).results[0].status,'verified');
  const nullable={...task,assignee:null,dueDate:null};const g=await fixture();
  const p=notionPayload(config,schema,nullable,meeting,`actiondesk:${await digest(`user\nsource\n${task.id}`)}`);
  g.page.properties.負責人.rich_text=[];g.page.properties.截止日期.date=null;
  g.blocks.splice(0,4,...p.children);
  assert.equal((await verifyTasks('user',meeting,[nullable],config,schema,g.fetcher)).results[0].status,'verified');
});
test('source markers are scoped to user and data source, independent of page receipts',async()=>{
  const markers=[];
  const fetcher=async(url,init)=>{assert.ok(url.endsWith('/query'));markers.push(JSON.parse(init.body).filter.rich_text.equals);return Response.json({results:[],has_more:false});};
  await verifyTasks('user',meeting,[task],config,schema,fetcher);
  await verifyTasks('other',meeting,[task],config,schema,fetcher);
  await verifyTasks('user',meeting,[task],{...config,dataSourceId:'other'},schema,fetcher);
  assert.equal(new Set(markers).size,3);
});
test('full rich text is compared across all fragments, not just the first 2000 characters',async()=>{
  const f=await fixture();
  const longTask={...task,evidence:'原'.repeat(4100)};
  const payload=notionPayload(config,schema,longTask,meeting,`actiondesk:${await digest(`user\nsource\n${task.id}`)}`);
  f.blocks.splice(0,4,...structuredClone(payload.children));
  assert.equal((await verifyTasks('user',meeting,[longTask],config,schema,f.fetcher)).results[0].status,'verified');
  const tail=f.blocks[1].paragraph.rich_text.at(-1);tail.text.content+='偽';tail.plain_text=payload.children[1].paragraph.rich_text.at(-1).text.content;
  assert.equal((await verifyTasks('user',meeting,[longTask],config,schema,f.fetcher)).results[0].status,'mismatch');
});
