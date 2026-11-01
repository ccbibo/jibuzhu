import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildAttribution } from '../lib/attribution.ts';
import { buildManagerBoard } from '../lib/manager-board.ts';

// Independent DOM-contract regression: executes the shipped script, never a provider.
function uiFixture(fetcher=async()=>{throw Error('Unexpected fetch');}){
  class Element {
    constructor(tag='div',text=''){this.tagName=tag;this.textContent=text;this.children=[];this.value='';this.dataset={};this.listeners={};this.hidden=false;this.disabled=false;this.attrs={};}
    get childNodes(){return this.children;}
    append(...items){for(const item of items)this.insertBefore(item,null);}
    insertBefore(item,reference){
      if(reference!==null&&!this.children.includes(reference))throw Error('Reference is not a child');
      if(item===reference)return item;
      if(item.parentNode)item.parentNode.removeChild(item);
      const index=reference===null?this.children.length:this.children.indexOf(reference);
      this.children.splice(index,0,item);item.parentNode=this;return item;
    }
    removeChild(item){const index=this.children.indexOf(item);if(index<0)throw Error('Node is not a child');this.children.splice(index,1);item.parentNode=null;return item;}
    replaceChildren(...items){for(const child of [...this.children])this.removeChild(child);this.append(...items);}
    contains(item){return this===item||this.children.some(child=>child.contains(item));}
    querySelectorAll(selector){const tags=selector.split(',');return this.children.flatMap(child=>[...(tags.includes(child.tagName)?[child]:[]),...child.querySelectorAll(selector)]);}
    get isConnected(){return [...elements.values()].some(root=>root!==this&&root.contains(this));}
    focus(){document.activeElement=this;}

    setAttribute(k,v){this.attrs[k]=v;}
    getAttribute(k){return this.attrs[k]??null;}
    addEventListener(k,fn){this.listeners[k]=fn;}
    checkValidity(){return true;}
    set innerHTML(_){throw Error('Untrusted HTML sink used');}
  }
  const html=readFileSync(new URL('../standalone/attribution.html',import.meta.url),'utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  for(const [key,value] of Object.entries({'meeting-title':'UI synthetic','meeting-date':'2026-10-31','meeting-mode':'rules',transcript:'A：UI source','demo-actor':'demo-pinyu'}))elements.get(key).value=value;
  const document={listeners:{},addEventListener(type,handler){this.listeners[type]=handler;},getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text),querySelectorAll:()=>[],activeElement:null,body:new Element('body')};
  const context=vm.createContext({document,Option:function(text,value){const n=new Element('option',text);n.value=value;return n;},AbortController,TextDecoder,fetch:fetcher,Set,Map,Date,crypto,console,navigator:{},Blob,URL,setTimeout:(fn,delay)=>{const timer=setTimeout(fn,delay);timer.unref?.();return timer;},clearTimeout});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1]+`;globalThis.ui={request,invalidate,render,renderPeople,setMode,renderManagerBoard,setManagerView,renderTeamAI,checkTeamAI,runTeamAI,updateTeamAIControls,getData:()=>data,setData:x=>{data=x},getTracking:()=>managerTracking,getHighlights:()=>managerHighlights,getConfigured:()=>teamAIConfigured};`,context);
  return {ui:context.ui,elements,context};
}
function uiText(node){return node.textContent+' '+node.children.map(uiText).join(' ');}
function nodes(root){return [root,...root.children.flatMap(nodes)];}
function buttons(root,text){return nodes(root).filter(n=>n.tagName==='button'&&n.textContent===text);}
const meeting={title:'獨立團隊驗收',meetingDate:'2026-10-31',mode:'rules',transcript:'A：第一位確認。\nA：第二位確認。\nA：尚待本人確認。\nA：這行沿用與爭議。\nA：我會整理表格。\nA：我已完成表格。\n沿用上一個標記。\n沒有標記的段落'};
async function source(){
 const participants=[{id:'one',name:'同名'},{id:'two',name:'同名'}];
 const initial=await buildAttribution(meeting,participants,[]),events=[];
 for(const [i,id] of [[0,'one'],[1,'two']])for(const action of ['claim','confirm'])events.push({id:id+action,actorId:id,action,segmentIds:[initial.segments[i].id]});
 events.push({id:'pending',actorId:'one',action:'claim',segmentIds:[initial.segments[2].id]});
 for(const id of ['one','two'])events.push({id:'dispute-'+id,actorId:id,action:'claim',segmentIds:[initial.segments[3].id]});
 const data=await buildAttribution(meeting,participants,events);data.managerBoard=await buildManagerBoard(meeting,data);return data;
}
function load(f,data){f.ui.setData(data);f.ui.renderManagerBoard();return data;}
const finding=(id,lineIndices,kind='highlight',text=id)=>({id,kind,text,citations:lineIndices.map(lineIndex=>({lineIndex,quote:meeting.transcript.split('\n')[lineIndex]})),requiresReview:true});
const result=(data,items)=>({mode:'ai',meetingId:data.meetingId,items,caveats:[],coverage:{characters:meeting.transcript.length,processedChunks:1,chunkCount:1,complete:true}});

test('team UI: both ordinary demo roles can open the same team overview',async()=>{
 const f=uiFixture();load(f,await source());
 for(const actor of ['demo-pinyu','demo-guanting']){
  f.elements.get('demo-actor').value=actor;f.elements.get('demo-actor').onchange();
  f.elements.get('canvas-view').onclick();assert.equal(f.elements.get('manager-board').hidden,true);
  f.elements.get('manager-view').onclick();assert.equal(f.elements.get('manager-board').hidden,false);
  assert.match(uiText(f.elements.get('manager-content')),/團隊總覽/);
 }
});
test('team UI: actual backend board keeps equal names separate and unresolved outside confirmed identities',async()=>{
 const f=uiFixture(),data=load(f,await source()),cards=nodes(f.elements.get('manager-content')).filter(n=>n.className==='manager-person');
 assert.equal(cards.filter(n=>uiText(n).includes('確認歸屬')).length,2);
 assert.ok(cards.some(n=>uiText(n).includes('確認歸屬 · person:one')));
 assert.ok(cards.some(n=>uiText(n).includes('確認歸屬 · person:two')));
 const unresolved=nodes(f.elements.get('manager-content')).find(n=>n.className==='manager-unresolved');unresolved.open=true;unresolved.ontoggle();
 assert.ok(uiText(unresolved).includes(data.segments[3].text));assert.ok(uiText(unresolved).includes(data.segments[6].text));
 assert.ok(cards.filter(n=>uiText(n).includes('確認歸屬')).every(n=>!uiText(n).includes(data.segments[2].text)));
});
test('team UI: AI citations group by exact confirmed IDs; pending explicit labels remain provisional; cross-person and inherited/disputed citations stay unresolved',async()=>{
 const f=uiFixture(),data=load(f,await source());
 const items=[finding('first',[0]),finding('second',[1]),finding('pending',[2]),finding('cross',[0,1]),finding('mixed',[0,2]),finding('inherited',[6]),finding('disputed',[3])];
 f.ui.renderTeamAI(result(data,items));
 const groups=nodes(f.elements.get('team-ai-results')).filter(n=>n.className==='team-ai-group');
 assert.deepEqual(groups.map(n=>n.children[0].textContent),['同名 · one','同名 · two','原文標記 A（未確認身分）','跨人討論・身分待確認']);
 for(const id of ['cross','mixed','inherited','disputed'])assert.ok(uiText(groups[3]).includes(id));
 assert.ok(!uiText(groups[0]).includes('cross'));assert.ok(!uiText(groups[2]).includes('mixed'));
});
test('team UI: AI task is manually adopted once; preserves existing owner/status; completion report never completes work',async()=>{
 const f=uiFixture(),data=load(f,await source()),root=f.elements.get('manager-content');
 buttons(root,'納入追蹤')[0].onclick();
 const owner=nodes(root).find(n=>n.tagName==='input'),status=nodes(root).find(n=>n.tagName==='select');
 owner.value='手動負責人';owner.oninput();status.value='doing';status.onchange();
 const before=JSON.stringify([...f.ui.getTracking()]),count=data.managerBoard.tasks.length;
 const items=[finding('novel',[0,1],'task','<img src=x onerror=alert(1)>'),finding('completed',[5],'completion_report')];
 f.ui.renderTeamAI(result(data,items));assert.equal(JSON.stringify([...f.ui.getTracking()]),before);
 assert.match(uiText(f.elements.get('team-ai-results')), /未改動右側追蹤或完成標記/);
 const add=buttons(f.elements.get('team-ai-results'),'納入追蹤')[0];add.onclick();add.onclick();
 assert.equal(data.managerBoard.tasks.length,count+1);for(const [id,review]of JSON.parse(before))assert.deepEqual(JSON.parse(JSON.stringify(f.ui.getTracking().get(id))),review);assert.equal(f.ui.getTracking().get('ai:novel').assignee,'');assert.equal(f.ui.getTracking().get('ai:novel').status,'todo');
 const candidate=data.managerBoard.tasks.at(-1);assert.equal(candidate.speakerId,null);assert.equal(candidate.assignee,null);
 assert.ok(uiText(root).includes('<img src=x onerror=alert(1)>'));assert.ok(nodes(root).some(n=>n.tagName==='select'&&n.value==='todo'));
 assert.equal(buttons(f.elements.get('team-ai-results'),'已納入追蹤')[0].disabled,true);
});
test('team UI: source changes clear review, consent and AI results; stale candidate closures cannot alter new source',async()=>{
 const f=uiFixture(),data=load(f,await source());buttons(f.elements.get('manager-content'),'納入追蹤')[0].onclick();
 buttons(f.elements.get('manager-content'),'標記為重點')[0].onclick();
 f.ui.renderTeamAI(result(data,[finding('stale',[0,1],'task')]));const old=buttons(f.elements.get('team-ai-results'),'納入追蹤')[0];f.elements.get('team-ai-approved').checked=true;
 f.elements.get('transcript').listeners.input();assert.equal(f.ui.getData(),null);assert.equal(f.ui.getTracking().size,0);assert.equal(f.ui.getHighlights().size,0);assert.equal(f.elements.get('team-ai-approved').checked,false);assert.equal(f.elements.get('team-ai-results').children.length,0);
 const fresh=load(f,await source()),count=fresh.managerBoard.tasks.length;old.onclick();assert.equal(fresh.managerBoard.tasks.length,count);
});
test('team UI: key configuration and explicit consent are both required before any AI request',async()=>{
 const calls=[];let configured=false;
 const f=uiFixture(async(url,options)=>{calls.push({url,options});if(url==='/api/status')return {ok:true,json:async()=>({aiConfigured:configured})};return {ok:false,json:async()=>({error:'mock-only error'})};});load(f,await source());
 await f.ui.runTeamAI();assert.equal(calls.length,0);
 f.elements.get('team-ai-approved').checked=true;await f.ui.runTeamAI();assert.equal(calls.length,0);
 await f.ui.checkTeamAI();assert.equal(f.elements.get('team-ai-run').disabled,true);await f.ui.runTeamAI();assert.equal(calls.length,1);
 configured=true;await f.ui.checkTeamAI();f.elements.get('team-ai-approved').checked=false;f.ui.updateTeamAIControls();await f.ui.runTeamAI();assert.equal(calls.length,2);assert.equal(f.elements.get('team-ai-run').disabled,true);
 f.elements.get('team-ai-approved').checked=true;f.elements.get('team-ai-approved').onchange();assert.equal(f.elements.get('team-ai-run').disabled,false);await f.ui.runTeamAI();
 assert.equal(calls.length,3);assert.equal(calls[2].url,'/api/team-summary');const body=JSON.parse(calls[2].options.body);assert.equal(body.approved,true);assert.deepEqual(Object.keys(body),['meeting','provider','model','approved']);assert.equal(calls[2].options.credentials,'same-origin');assert.match(f.elements.get('team-ai-status').textContent,/mock-only/);
});
test('team UI: late AI response and late config response are discarded after source invalidation',async()=>{
 let finish;const f=uiFixture(async url=>url==='/api/status'?{ok:true,json:async()=>({aiConfigured:true})}:new Promise(resolve=>{finish=resolve;})),data=load(f,await source());await f.ui.checkTeamAI();f.elements.get('team-ai-approved').checked=true;
 const pending=f.ui.runTeamAI();f.elements.get('meeting-date').listeners.input();finish({ok:true,json:async()=>result(data,[finding('late',[0])])});await pending;assert.equal(f.elements.get('team-ai-results').children.length,0);assert.equal(f.elements.get('team-ai-run').disabled,true);
 let configFinish;const g=uiFixture(()=>new Promise(resolve=>{configFinish=resolve;}));const check=g.ui.checkTeamAI();g.ui.invalidate();configFinish({ok:true,json:async()=>({aiConfigured:true})});await check;assert.equal(g.ui.getConfigured(),null);
});
test('team UI: source-mismatched AI result fails closed without touching existing tracking',async()=>{
 let data;const f=uiFixture(async url=>url==='/api/status'?{ok:true,json:async()=>({aiConfigured:true})}:{ok:true,json:async()=>({...result(data,[finding('bad',[0])]),meetingId:'wrong-source'})});data=load(f,await source());buttons(f.elements.get('manager-content'),'納入追蹤')[0].onclick();const before=JSON.stringify([...f.ui.getTracking()]);await f.ui.checkTeamAI();f.elements.get('team-ai-approved').checked=true;await f.ui.runTeamAI();assert.equal(f.elements.get('team-ai-results').children.length,0);assert.match(f.elements.get('team-ai-status').textContent,/來源不符/);assert.equal(JSON.stringify([...f.ui.getTracking()]),before);
});
test('team UI: successful mocked AI route renders quoted output without changing tracking or consent',async()=>{
 let data;const f=uiFixture(async url=>({ok:true,json:async()=>url==='/api/status'?{aiConfigured:true}:result(data,[finding('success',[0],'suggestion','建議保留備案')])}));data=load(f,await source());buttons(f.elements.get('manager-content'),'納入追蹤')[0].onclick();const before=JSON.stringify([...f.ui.getTracking()]);await f.ui.checkTeamAI();f.elements.get('team-ai-approved').checked=true;await f.ui.runTeamAI();assert.match(uiText(f.elements.get('team-ai-results')),/建議保留備案/);assert.match(uiText(f.elements.get('team-ai-results')),/確認歸屬：同名 · one/);assert.equal(JSON.stringify([...f.ui.getTracking()]),before);assert.equal(f.elements.get('team-ai-approved').checked,true);assert.equal(f.elements.get('team-ai-run').disabled,false);
});
test('team UI: title/date/mode/transcript and source switches each reset ephemeral review',async()=>{
 for(const control of ['meeting-title','meeting-date','meeting-mode','transcript','notion-mode']){
  const f=uiFixture();load(f,await source());buttons(f.elements.get('manager-content'),'納入追蹤')[0].onclick();f.elements.get('team-ai-approved').checked=true;
  if(control==='notion-mode')f.ui.setMode('notion');else f.elements.get(control).listeners[control==='meeting-mode'?'change':'input']();
  assert.equal(f.ui.getData(),null,control);assert.equal(f.ui.getTracking().size,0,control);assert.equal(f.elements.get('team-ai-approved').checked,false,control);assert.equal(f.elements.get('team-ai-run').disabled,true,control);
 }
});


test('team UI: same-source attribution refresh preserves adopted AI owner, state, highlights and summary without duplicates',async()=>{
 const f=uiFixture(),first=load(f,await source());buttons(f.elements.get('manager-content'),'標記為重點')[0].onclick();
 const summary=result(first,[finding('refresh-task',[0,1],'task','跨人工作')]);f.ui.renderTeamAI(summary);buttons(f.elements.get('team-ai-results'),'納入追蹤')[0].onclick();
 const root=f.elements.get('manager-content'),owner=nodes(root).find(n=>n.tagName==='input');owner.value='人工負責人';owner.oninput();const status=nodes(root).find(n=>n.tagName==='select');status.value='doing';status.onchange();
 const fresh=load(f,await source());assert.equal(fresh.managerBoard.tasks.filter(t=>t.id==='ai:refresh-task').length,1);assert.equal(f.ui.getTracking().get('ai:refresh-task').assignee,'人工負責人');assert.equal(f.ui.getTracking().get('ai:refresh-task').status,'doing');assert.equal(f.ui.getHighlights().size,1);assert.match(uiText(f.elements.get('team-ai-results')),/跨人工作/);
 f.ui.renderManagerBoard(true);assert.equal(fresh.managerBoard.tasks.filter(t=>t.id==='ai:refresh-task').length,1);
});

test('team UI: source invalidation suspends active review; different meeting never restores it',async()=>{
 const f=uiFixture(),first=load(f,await source());buttons(f.elements.get('manager-content'),'納入追蹤')[0].onclick();f.ui.invalidate();assert.equal(f.ui.getTracking().size,0);
 const fresh=await source();fresh.meetingId='different-source';load(f,fresh);assert.equal(f.ui.getTracking().size,0);assert.equal(f.elements.get('team-ai-results').children.length,0);assert.notEqual(first.meetingId,fresh.meetingId);
});

test('team UI: long raw groups create three excerpts initially and append three on demand without rebuilding tracking',async()=>{
 const f=uiFixture(),data=await source();data.managerBoard.people=[{id:'source:A',name:'原文標記 A（未確認身分）',identity:'source',excerpts:Array.from({length:1000},(_,i)=>({id:'many'+i,lineIndex:i,text:'原話'+i})),suggestions:[],tasks:[]}];load(f,data);const root=f.elements.get('manager-content');assert.equal(buttons(root,'標記為重點').length,3);buttons(root,'納入追蹤')[0].onclick();const owner=nodes(root).find(n=>n.tagName==='input');buttons(root,'標記為重點')[0].onclick();assert.equal(nodes(root).find(n=>n.tagName==='input'),owner);const more=nodes(root).find(n=>n.tagName==='button'&&n.textContent.startsWith('再看 3 段'));more.onclick();assert.equal(buttons(root,'標記為重點').length,5);assert.equal(nodes(root).find(n=>n.tagName==='input'),owner);
});

test('team UI: stop button aborts AI and rejects the late response without adopting incomplete results',async()=>{
 let finish,signal;const f=uiFixture(async(url,options)=>url==='/api/status'?{ok:true,json:async()=>({aiConfigured:true,provider:'deepseek',providerLabel:'DeepSeek',model:'deepseek-flash'})}:new Promise(resolve=>{finish=resolve;signal=options.signal;})),data=load(f,await source());await f.ui.checkTeamAI();f.elements.get('team-ai-approved').checked=true;const pending=f.ui.runTeamAI();assert.equal(f.elements.get('team-ai-stop').hidden,false);f.elements.get('team-ai-stop').onclick();assert.equal(signal.aborted,true);assert.equal(f.elements.get('team-ai-stop').hidden,true);finish({ok:true,json:async()=>result(data,[finding('late-cancel',[0])])});await pending;assert.equal(f.elements.get('team-ai-results').children.length,0);assert.match(f.elements.get('team-ai-status').textContent,/已停止整理/);
});

test('team UI: UTF-8 file import accepts text locally and rejects oversize files before reading',async()=>{
 const f=uiFixture();let read=0;f.elements.get('source-file').files=[{name:'large.txt',size:180001,arrayBuffer:async()=>{read++;return new ArrayBuffer(0);}}];await f.elements.get('source-file').listeners.change();assert.equal(read,0);assert.match(f.elements.get('source-import-status').textContent,/180 KB/);
 f.elements.get('source-file').files=[{name:'meeting.md',size:30,arrayBuffer:async()=>new TextEncoder().encode('A：匯入的原話').buffer}];await f.elements.get('source-file').listeners.change();assert.equal(f.elements.get('transcript').value,'A：匯入的原話');assert.equal(f.ui.getData(),null);assert.match(f.elements.get('source-import-status').textContent,/已匯入/);
});


test('team UI: workspace demo restore replays local events and restores review without an AI generation request',async()=>{
 const restored=await source(),calls=[],savedReview={provenance:'demo',events:[],tracking:[{id:restored.managerBoard.tasks[0].id,assignee:'暫存負責人',status:'doing'}],highlights:[],aiTasks:[],aiResult:null,aiProvider:'deepseek',aiModel:'deepseek-flash'};
 const f=uiFixture(async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url==='/api/status'?{aiConfigured:true,provider:'deepseek',providerLabel:'DeepSeek',model:'deepseek-flash'}:restored};});
 let persisted;f.context.window={JibuzhuWorkspace:{readMeeting:()=>({...meeting,id:restored.meetingId,date:meeting.meetingDate}),readReview:()=>savedReview,saveMeeting:()=>true,saveReview:(_id,review,scope)=>{persisted={review,scope};return true;}}};
 await vm.runInContext('restoreTeamWorkspace()',f.context);assert.deepEqual(calls.map(c=>c.url),['/api/attribution/demo','/api/status']);assert.equal(f.ui.getTracking().get(restored.managerBoard.tasks[0].id).assignee,'暫存負責人');assert.equal(f.ui.getTracking().get(restored.managerBoard.tasks[0].id).status,'doing');assert.equal(f.elements.get('team-ai-approved').checked,false);assert.equal(persisted.scope,'speakers');assert.ok(!('segments'in persisted.review));
});

test('team UI: workspace Notion restore never treats cached identities as live or automatically contacts Notion',async()=>{
 const restored=await source(),calls=[],f=uiFixture(async url=>{calls.push(url);throw Error('must not fetch');});f.context.window={JibuzhuWorkspace:{readMeeting:()=>({...meeting,id:restored.meetingId}),readReview:()=>({provenance:'notion',tracking:[{id:'x',assignee:'人工人員',status:'todo'}],events:[{id:'forged'}],highlights:[],aiTasks:[],aiResult:null})}};
 await vm.runInContext('restoreTeamWorkspace()',f.context);assert.equal(calls.length,0);assert.equal(f.ui.getData(),null);assert.equal(f.ui.getTracking().size,0);assert.match(f.elements.get('source-import-status').textContent,/重新讀取 Notion/);assert.equal(f.elements.get('team-ai-approved').checked,false);
});

test('team UI: actual scoped workspace preserves manual review and AI across a same-tab page reload',async()=>{
 const storage=new Map(),browser={sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};
 const make=()=>uiFixture(async url=>({ok:true,json:async()=>url==='/api/status'?{aiConfigured:true,provider:'deepseek',providerLabel:'DeepSeek',model:'deepseek-flash'}:await source()}));
 const f=make();f.context.window=browser;vm.runInContext(readFileSync(new URL('../public/assets/workspace.js',import.meta.url),'utf8'),f.context);
 for(const [id,key]of [['meeting-title','title'],['meeting-date','meetingDate'],['meeting-mode','mode'],['transcript','transcript']])f.elements.get(id).value=meeting[key];
 const data=load(f,await source());await f.ui.checkTeamAI();buttons(f.elements.get('manager-content'),'標記為重點')[0].onclick();f.ui.renderTeamAI(result(data,[finding('persisted-ai',[0,1],'task','需要人工追蹤的工作')]));buttons(f.elements.get('team-ai-results'),'納入追蹤')[0].onclick();
 const owner=nodes(f.elements.get('manager-content')).find(n=>n.tagName==='input');owner.value='持續化負責人';owner.oninput();const status=nodes(f.elements.get('manager-content')).find(n=>n.tagName==='select');status.value='doing';status.onchange();
 const stored=browser.JibuzhuWorkspace.readReview(data.meetingId,'speakers');assert.equal(stored.tracking.find(t=>t.id==='ai:persisted-ai').assignee,'持續化負責人');assert.equal(stored.aiTasks.length,1);assert.ok(!('segments'in stored));
 const second=make();second.context.window=browser;await vm.runInContext('restoreTeamWorkspace()',second.context);assert.equal(second.ui.getTracking().get('ai:persisted-ai').assignee,'持續化負責人');assert.equal(second.ui.getTracking().get('ai:persisted-ai').status,'doing');assert.equal(second.ui.getHighlights().size,1);assert.match(uiText(second.elements.get('team-ai-results')),/需要人工追蹤的工作/);assert.equal(second.elements.get('team-ai-approved').checked,false);assert.match(second.elements.get('workflow-notion').textContent,/審閱 1 項待辦並寫入 Notion/);
});


test('team UI: visible meeting export includes manual review and source without connection credentials or consent',async()=>{
 const f=uiFixture(),data=load(f,await source());assert.equal(buttons(f.elements.get('manager-content'),'匯出會議').length,1);buttons(f.elements.get('manager-content'),'納入追蹤')[0].onclick();const owner=nodes(f.elements.get('manager-content')).find(n=>n.tagName==='input');owner.value='匯出負責人';owner.oninput();buttons(f.elements.get('manager-content'),'標記為重點')[0].onclick();const payload=vm.runInContext('teamExportPayload()',f.context);assert.equal(payload.data.meetingId,data.meetingId);assert.equal(payload.meeting.transcript,f.elements.get('transcript').value);assert.equal(payload.review.tracking[0].assignee,'匯出負責人');assert.equal(payload.review.highlights.length,1);assert.match(payload.notice,/不是身分證明/);assert.match(payload.notice,/未同步 Notion/);assert.ok(!Object.keys(payload).some(key=>/key|cookie|consent/i.test(key)));assert.ok(!Object.keys(payload.review).some(key=>/key|cookie|consent|approved/i.test(key)));
});

test('task-first workflow: input is directly reachable, person cards remain distinct, adoption enables Notion review without external writing',async()=>{
 const f=uiFixture();
 assert.equal(f.elements.get('workflow-review').disabled,true);
 assert.equal(f.elements.get('workflow-notion').disabled,true);
 f.elements.get('workflow-import').onclick();
 assert.equal(f.elements.get('source-panel').open,true);
 assert.equal(f.context.document.activeElement,f.elements.get('transcript'));
 f.elements.get('source-close').onclick();
 assert.equal(f.elements.get('source-panel').open,false);
 const names=['品妤','冠廷','思涵','柏翰','雅婷','承恩','怡安','俊宇','佳穎','子翔'];
 const meeting={title:'人物卡合成驗收',meetingDate:'2026-11-01',mode:'rules',transcript:names.map(name=>name+'：我會在明天完成活動清單。').join('\n')};
 const data=await buildAttribution(meeting,[],[]);data.managerBoard=await buildManagerBoard(meeting,data);load(f,data);
 const roster=nodes(f.elements.get('manager-content')).filter(n=>n.className==='member-card');
 assert.equal(roster.length,10);
 assert.equal(new Set(roster.map(card=>nodes(card).find(n=>n.className==='person-face').getAttribute('style'))).size,10);
 assert.ok(roster.every(card=>uiText(card).includes('原文標記 · 待認領')));
 assert.ok(data.segments.every(segment=>segment.status!=='confirmed'));
 assert.equal(f.elements.get('workflow-review').disabled,false);
 roster[9].onclick();
 assert.match(uiText(f.context.document.activeElement),/子翔/);
 const adopt=buttons(f.context.document.activeElement,'納入追蹤')[0];assert.ok(adopt);adopt.onclick();
 assert.equal(f.ui.getTracking().size,1);
 assert.equal([...f.ui.getTracking().values()][0].assignee,'');
 assert.match(f.elements.get('workflow-notion').textContent,/審閱 1 項待辦並寫入 Notion/);
 assert.match(uiText(f.context.document.activeElement),/子翔/);
 // Fetcher rejects any external request: opening a card and adoption are local only.
});
