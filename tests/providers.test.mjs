import test from 'node:test';
import assert from 'node:assert/strict';
import {getNotionSchema,notionPayload,providerFetch,safeNotionUrl,extractAI,NOTION_VERSION} from '../lib/providers.ts';
import {extractRules} from '../lib/task-engine.ts';
const meeting={title:'分校週會',meetingDate:'2026-10-31',transcript:'小美：我會明天提交報表。',mode:'rules'};
const config={model:'gpt-4o-mini',notionToken:'test-only',dataSourceId:'test-datasource'};
const schema={titleName:'任務',targetName:'任務表',properties:{任務:{type:'title'},'來源 ID':{type:'rich_text'},負責人:{type:'rich_text'},截止日期:{type:'date'},優先級:{type:'select'}}};
const ok=(body)=>Response.json(body);
test('Notion schema requires durable external source id, rejects wrong optional field types',async()=>{
  await assert.rejects(getNotionSchema(config,async()=>ok({properties:{Name:{type:'title'}}})),/來源 ID/);
  await assert.rejects(getNotionSchema(config,async()=>ok({properties:{...schema.properties,負責人:{type:'people'}}})),/負責人/);
  const out=await getNotionSchema(config,async(_url,init)=>{assert.equal(init.headers['Notion-Version'],NOTION_VERSION);return ok({properties:schema.properties,title:[{plain_text:'正式任務'}]});});
  assert.equal(out.titleName,'任務');assert.equal(out.targetName,'正式任務');
});
test('Notion page payload uses data source parent and retains human-readable original evidence',async()=>{
  const {tasks}=await extractRules(meeting),payload=notionPayload(config,schema,tasks[0],meeting,'source-001');
  assert.deepEqual(payload.parent,{type:'data_source_id',data_source_id:config.dataSourceId});
  assert.equal(payload.properties['來源 ID'].rich_text[0].text.content,'source-001');
  assert.equal(payload.properties['截止日期'].date.start,'2026-11-01');
  assert.ok(JSON.stringify(payload.children).includes(meeting.transcript));
});
test('external errors sanitize response body and preserve retry timing without auto retry',async()=>{
  let count=0;
  await assert.rejects(providerFetch('https://api.notion.com/v1/pages',{},async()=>{count++;return new Response('secret private provider details',{status:429,headers:{'Retry-After':'15'}});}),error=>error.retryAfter==='15'&&!error.message.includes('secret'));
  assert.equal(count,1);
});
test('write network failure is uncertain, never reported as success',async()=>{
  await assert.rejects(providerFetch('https://api.notion.com/v1/pages',{},async()=>{throw new Error('secret');},true),error=>error.uncertain===true&&!error.message.includes('secret'));
});
test('returned links reject javascript and lookalike hosts',()=>{
  assert.equal(safeNotionUrl('javascript:alert(1)'),undefined);
  assert.equal(safeNotionUrl('https://app.notion.com.evil.test/p/123'),undefined);
  assert.equal(safeNotionUrl('https://app.notion.com/p/123'),'https://app.notion.com/p/123');
});
test('AI mode uses structured output, does not enable tools, validates source evidence',async()=>{
  const {tasks}=await extractRules(meeting);
  const result=await extractAI({...meeting,mode:'ai'},{...config,openaiKey:'fake-test-key'},async(_url,init)=>{
    const body=JSON.parse(init.body);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.equal(body.tools,undefined);
    return ok({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({summary:'整理結果',tasks})}]}]});
  });
  assert.equal(result.mode,'ai');assert.equal(result.tasks.length,1);
  await assert.rejects(extractAI(meeting,{...config,openaiKey:'fake'},async()=>ok({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({summary:'幻覺',tasks:[{...tasks[0],evidence:'不存在的原文'}]})}]}]})),/原文依據/);
});
test('AI missing config and incomplete response are explicit failures',async()=>{
  await assert.rejects(extractAI(meeting,config),/尚未設定/);
  await assert.rejects(extractAI(meeting,{...config,openaiKey:'fake'},async()=>ok({status:'incomplete',output:[]})),/未完成/);
});
