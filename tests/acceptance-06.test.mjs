import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../standalone/recall.html',import.meta.url),'utf8');
class Element {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.value='';this.hidden=false;this.disabled=false;this.listeners={};this.attributes={};this._text='';this.className='';this.files=[];this.classList={add:()=>{},remove:()=>{}};}
 set textContent(v){this._text=String(v);this.children=[];} get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
 set innerHTML(v){throw Error('Unsafe innerHTML mutation: '+v);}
 append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this._text='';this.children=[...nodes];}
 setAttribute(k,v){this.attributes[k]=v;} addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
 async fire(k,event={}){for(const fn of this.listeners[k]||[])await fn({target:this,preventDefault(){},...event});}
 focus(){} scrollIntoView(){} setCustomValidity(){} reportValidity(){} click(){} remove(){}
}
const flush=()=>new Promise(r=>setImmediate(r));
function harness(config=false){
 const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>{const el=new Element();el.id=m[1];return [m[1],el];}));
 const calls=[],downloads=[];let handler=async()=>({ok:true,json:async()=>({aiConfigured:config})});
 const context=vm.createContext({document:{getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),querySelector:()=>null,body:new Element('body')},fetch:async(url,opts)=>{calls.push({url,opts});return handler(url,opts);},AbortController,TextDecoder,TypeError,Blob,URL:{createObjectURL:b=>{downloads.push(b);return 'blob:fake';},revokeObjectURL(){}},setTimeout:()=>0,Date,console});
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
 return {elements,calls,downloads,run:s=>vm.runInContext(s,context),setHandler:fn=>handler=fn,$:id=>elements.get(id)};
}
const aiAnswer=(overrides={})=>({mode:'ai',meetingId:'m',question:'測試',speaker:'',claims:[{text:'觀點',kind:'viewpoint',citations:[{lineIndex:0,quote:'原文',speaker:'甲'}]}],caveats:['仍須查證'],notice:'完成',...overrides});

test('06: initialization and switching never submit transcript; missing AI config is clear',async()=>{
 const h=harness();await flush();assert.deepEqual(h.calls.map(x=>x.url),['/api/status']);assert.equal(h.$('ask').disabled,true);assert.match(h.$('ai-config').textContent,/尚未設定/);assert.equal(h.$('ai-setup').hidden,false);
 h.run("changeMode('ai'); changeMode('literal');");assert.equal(h.calls.length,1);assert.match(h.$('status').textContent,/詞彙/);
});
test('06: literal request keeps original case; no-results avoids claiming no discussion',async()=>{
 const h=harness();await flush();h.$('query').value='API api';h.$('speaker').value='甲';h.setHandler(async(url,opts)=>({ok:true,json:async()=>({totalMatches:0,hits:[],notice:'按字面回找'})}));await h.$('recall-form').fire('submit');
 const sent=JSON.parse(h.calls.at(-1).opts.body);assert.equal(sent.query,'API api');assert.match(h.$('results').textContent,/沒有符合這組/);assert.match(html,/沒有命中，也不代表沒有討論/);
});
test('06: source edit aborts and ignores late literal response',async()=>{
 const h=harness();await flush();let resolve;h.setHandler(()=>new Promise(r=>resolve=r));const pending=h.$('recall-form').fire('submit');await flush();const request=h.calls.at(-1);h.$('transcript').value='新原文';await h.$('transcript').fire('input');assert.equal(request.opts.signal.aborted,true);resolve({ok:true,json:async()=>({totalMatches:999,hits:[]})});await pending;assert.equal(h.$('result-count').textContent,'');assert.match(h.$('status').textContent,/條件已變更/);
});
test('06: UTF-8 import is local and rejects encoding, extension, emptiness and bounds',async()=>{
 const h=harness();await flush();const before=h.calls.length;const original=h.$('transcript').value;
 const importFile=async(name,bytes,size=bytes.length)=>{h.$('source-file').files=[{name,size,arrayBuffer:async()=>Uint8Array.from(bytes).buffer}];await h.$('source-file').fire('change');};
 await importFile('bad.txt',[255]);assert.match(h.$('import-status').textContent,/UTF-8/);assert.equal(h.$('transcript').value,original);
 await importFile('bad.csv',[65]);assert.match(h.$('import-status').textContent,/\.txt/);
 await importFile('empty.md',[32]);assert.match(h.$('import-status').textContent,/為空/);
 await importFile('large.txt',[65],180001);assert.match(h.$('import-status').textContent,/過大/);
 await importFile('chars.txt',new TextEncoder().encode('a'.repeat(45001)));assert.match(h.$('import-status').textContent,/超過/);
 await importFile('ok.md',new TextEncoder().encode('甲：中文 API'));assert.equal(h.$('transcript').value,'甲：中文 API');assert.equal(h.calls.length,before);
});
test('06: pending import cannot overwrite a later manual source edit',async()=>{
 const h=harness();await flush();let resolve;h.$('source-file').files=[{name:'slow.txt',size:5,arrayBuffer:()=>new Promise(r=>resolve=r)}];const pending=h.$('source-file').fire('change');h.$('transcript').value='使用者新編輯';await h.$('transcript').fire('input');resolve(new TextEncoder().encode('舊匯入').buffer);await pending;assert.equal(h.$('transcript').value,'使用者新編輯');
});
test('06: pending AI response cannot repopulate after question change',async()=>{
 const h=harness(true);await flush();h.run("changeMode('ai')");h.$('question').value='原問題';let resolve;h.setHandler(()=>new Promise(r=>resolve=r));const pending=h.$('recall-form').fire('submit');await flush();assert.equal(h.calls.at(-1).url,'/api/ask');assert.ok(JSON.parse(h.calls.at(-1).opts.body).meeting.transcript);h.$('question').value='新問題';await h.$('question').fire('input');resolve({ok:true,json:async()=>aiAnswer()});await pending;assert.equal(h.$('results').textContent,'');assert.equal(h.$('export-panel').hidden,true);assert.equal(h.run('history.length'),0);
});
test('06: AI render/history use text nodes; exports preserve JSON and escape Markdown',async()=>{
 const h=harness(true);await flush();const payload='<img src=x onerror=alert(1)> [link](javascript:alert(1))';h.run("changeMode('ai')");h.$('question').value='問題';h.setHandler(async()=>({ok:true,json:async()=>aiAnswer({question:payload,claims:[{text:payload,kind:'objection',citations:[{lineIndex:0,quote:payload,speaker:payload}]}]})}));await h.$('recall-form').fire('submit');assert.match(h.$('results').textContent,/<img/);assert.equal(h.run('history.length'),1);assert.match(h.$('history').textContent,/異議/);h.$('export-json').onclick();h.$('export-md').onclick();const json=JSON.parse(await h.downloads[0].text()),md=await h.downloads[1].text();assert.equal(json.question,payload);assert.ok(md.includes('\\<img')||md.includes('&lt;img'));assert.ok(md.includes('\\[link\\]\\(javascript:alert\\(1\\)\\)'));h.$('transcript').value='新逐字稿';await h.$('transcript').fire('input');assert.equal(h.run('history.length'),0);assert.equal(h.$('export-panel').hidden,true);
});
test('06: non-AI response cannot be displayed as genuine answer',async()=>{
 const h=harness(true);await flush();h.run("changeMode('ai')");h.$('question').value='問題';h.setHandler(async()=>({ok:true,json:async()=>aiAnswer({mode:'demo'})}));await h.$('recall-form').fire('submit');assert.match(h.$('status').textContent,/未顯示為 AI/);assert.equal(h.run('history.length'),0);assert.equal(h.$('export-panel').hidden,true);
});

test('06: quote-first cards keep false model interpretation collapsed and export review labels',async()=>{
 const h=harness(true);await flush();h.run("changeMode('ai')");h.$('question').value='是否同意';const answer=aiAnswer({verification:'quotes_only',claims:[{text:'甲已同意且全體達成決議',kind:'decision',requiresReview:true,citations:[{lineIndex:0,quote:'我反對，尚未定案',speaker:'甲'}]}]});h.setHandler(async()=>({ok:true,json:async()=>answer}));await h.$('recall-form').fire('submit');
 const card=h.$('results').children.find(x=>x.tagName==='article');assert.ok(card);const body=card.children[1],interpretation=body.children.find(x=>x.tagName==='details');assert.ok(interpretation);assert.ok(!interpretation.open);assert.match(interpretation.children[0].textContent,/模型解讀・未驗證/);assert.equal(body.children[0].tagName,'button');assert.match(body.children[0].textContent,/我反對，尚未定案/);assert.match(body.textContent,/人物歸屬、分類與決議仍待人工確認/);assert.match(h.$('history').textContent,/待人工確認/);
 h.$('export-json').onclick();h.$('export-md').onclick();const json=JSON.parse(await h.downloads[0].text()),md=await h.downloads[1].text();assert.equal(json.verification,'quotes_only');assert.equal(json.claims[0].requiresReview,true);assert.match(md,/模型解讀・未驗證/);assert.match(md,/模型分類：決議／待人工確認/);assert.match(md,/人物歸屬、分類與決議仍待人工確認/);
});
