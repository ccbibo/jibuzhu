import test from 'node:test';
import assert from 'node:assert/strict';
import { aiProvider, responseRequest, extractAI, ProviderError } from '../lib/providers.ts';
import { askMeeting } from '../lib/meeting-qa.ts';
import { summarizeTeam } from '../lib/team-summary.ts';

const config={provider:'deepseek',model:'deepseek-flash',deepseekKey:'deepseek-test-key',openaiKey:'openai-never-send'};
const meeting={title:'DeepSeek 測試',meetingDate:'2026-10-31',mode:'ai',transcript:'A：我會整理初稿。'};
const response=value=>Response.json({status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const task={title:'整理初稿',assignee:'A',dueDate:null,dueText:null,priority:'normal',evidence:'我會整理初稿。',lineIndex:0,warnings:[]};
const cases=[
 ['extract',fetcher=>extractAI(meeting,config,fetcher),{summary:'待查核',tasks:[task]}],
 ['ask',fetcher=>askMeeting({meeting,approved:true,provider:'deepseek',question:'有哪些承諾？',speaker:''},config,fetcher),{claims:[{kind:'viewpoint',text:'發言表示會整理初稿。',citations:[{lineIndex:0,quote:'我會整理初稿。'}]}],caveats:[]}],
 ['summary',fetcher=>summarizeTeam({meeting,approved:true,provider:'deepseek'},config,fetcher),{items:[{kind:'task',text:'整理初稿的承諾候選。',citations:[{lineIndex:0,quote:'我會整理初稿。'}]}],caveats:[]}],
];

test('server-selected provider isolates endpoint and credentials without fallback',async()=>{
 assert.equal(aiProvider(config).endpoint,'https://api.deepseek.com/responses');
 assert.equal(aiProvider({model:'openai-model',openaiKey:'openai-only',deepseekKey:'do-not-send'}).key,'openai-only');
 assert.equal(aiProvider({...config,model:''}).model,'deepseek-flash');
 let calls=0;const fetcher=async()=>{calls++;throw Error('must not call');};
 for(const c of [{...config,deepseekKey:undefined},{...config,deepseekKey:' '},{provider:'openai',model:'test',deepseekKey:'wrong-key'},{provider:'invalid',model:'test',openaiKey:'key'}]){
  await assert.rejects(()=>responseRequest(c,{},fetcher),e=>e instanceof ProviderError&&e.status===503);
 }
 assert.equal(calls,0);
});
test('DeepSeek request adaptation does not mutate caller data or weaken OpenAI requests',async()=>{
 const body={store:false,text:{format:{type:'json_schema',name:'test',strict:true,schema:{type:'object'}}},input:'data'};
 await responseRequest(config,body,async(_url,init)=>{const p=JSON.parse(init.body);assert.ok(!Object.hasOwn(p,'store'));assert.ok(!Object.hasOwn(p.text.format,'strict'));assert.equal(p.reasoning.effort,'none');return response({});});
 assert.equal(body.text.format.strict,true);assert.equal(body.store,false);
 await responseRequest({model:'openai-test',openaiKey:'openai-only'},body,async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.headers.Authorization,'Bearer openai-only');const p=JSON.parse(init.body);assert.equal(p.store,false);assert.equal(p.text.format.strict,true);assert.ok(!Object.hasOwn(p,'reasoning'));return response({});});
});
for(const [name,run,payload] of cases){
 test(`DeepSeek ${name} uses Responses adapter and retains evidence checks`,async()=>{
  let calls=0;
  const result=await run(async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/responses');assert.equal(init.headers.Authorization,'Bearer deepseek-test-key');assert.ok(!init.body.includes('openai-never-send'));const body=JSON.parse(init.body);assert.equal(body.model,'deepseek-flash');assert.equal(body.reasoning.effort,'none');assert.equal(body.text.format.type,'json_schema');assert.ok(body.text.format.schema);assert.ok(!Object.hasOwn(body.text.format,'strict'));assert.ok(!Object.hasOwn(body,'store'));return response(payload);});
  assert.equal(calls,1);assert.equal(result.mode,'ai');
  const bad=JSON.parse(JSON.stringify(payload));
  if(name==='extract')bad.tasks[0].evidence='偽造引文';else (bad.claims??bad.items)[0].citations[0].quote='偽造引文';
  await assert.rejects(()=>run(async()=>response(bad)),ProviderError);
 });
 test(`DeepSeek ${name} fails closed on incomplete output and refusal`,async()=>{
  for(const result of [{status:'failed',output:[]},{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]}])await assert.rejects(()=>run(async()=>Response.json(result)),ProviderError);
 });
 test(`DeepSeek ${name} rejects nested incomplete messages and tool outputs despite valid JSON`,async()=>{
  const content=[{type:'output_text',text:JSON.stringify(payload)}];
  for(const output of [
   [{type:'message',status:'incomplete',content}],
   [{type:'message',status:'in_progress',content}],
   [{type:'function_call',status:'completed',content}],
   [{type:'web_search_call',status:'completed'}, {type:'message',status:'completed',content}],
   [{type:'reasoning',status:'incomplete'}, {type:'message',status:'completed',content}],
  ])await assert.rejects(()=>run(async()=>Response.json({status:'completed',output})),ProviderError);
 });
}
test('missing selected key prevents all three features from contacting a provider',async()=>{
 const c={...config,deepseekKey:undefined};let calls=0;const f=async()=>{calls++;throw Error('unexpected');};
 for(const run of [()=>extractAI(meeting,c,f),()=>askMeeting({meeting,approved:true,provider:'deepseek',question:'承諾？',speaker:''},c,f),()=>summarizeTeam({meeting,approved:true,provider:'deepseek'},c,f)])await assert.rejects(run,e=>e.status===503);
 assert.equal(calls,0);
});
