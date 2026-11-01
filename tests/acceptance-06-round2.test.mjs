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


test('06-r2: format and import guidance are closed details; transcript remains editable outside',()=>{
 const help=html.match(/<details\b[^>]*class="[^"]*source-help[^\"]*"[^>]*>[\s\S]*?<\/details>/)?.[0];assert.ok(help);assert.ok(!/^<details[^>]*\bopen\b/.test(help));assert.match(help,/id="format-hint"/);assert.match(help,/id="source-file"/);assert.match(help,/id="import-hint"/);assert.match(help,/UTF-8/);assert.match(help,/45,000/);assert.ok(!help.includes('id="transcript"'));
 const textarea=html.match(/<textarea\b[^>]*id="transcript"[^>]*>/)?.[0];assert.ok(textarea);assert.ok(!/\b(readonly|disabled|hidden)\b/.test(textarea));
});
test('06-r2: history only appears after an answer; source edit hides history and synthetic metadata',async()=>{
 const h=harness(true);await flush();assert.match(html,/<section[^>]*id="history-panel"[^>]*\bhidden/);assert.equal(h.$('history-panel').hidden,true);assert.equal(h.$('sample-meta').hidden,false);
 h.run("changeMode('ai')");h.$('question').value='問題';h.setHandler(async()=>({ok:true,json:async()=>aiAnswer()}));await h.$('recall-form').fire('submit');assert.equal(h.$('history-panel').hidden,false);assert.equal(h.run('history.length'),1);
 h.$('transcript').value='甲：自訂內容';await h.$('transcript').fire('input');assert.equal(h.$('history-panel').hidden,true);assert.equal(h.$('sample-meta').hidden,true);assert.equal(h.run('history.length'),0);h.$('load-example').onclick();assert.equal(h.$('sample-meta').hidden,false);assert.equal(h.$('history-panel').hidden,true);
});
test('06-r2: simplified UI keeps explicit-send disclosure and simulation-vs-live distinction',async()=>{
 assert.match(html,/按下「送出 AI 問答」才傳送/);assert.match(html,/完整逐字稿、此題與人物條件/);assert.match(html,/傳給<span id="ai-provider-label">已設定的 AI 供應商<\/span>/);assert.match(html,/切換分頁與匯入不會呼叫模型/);assert.match(html,/逐字引文通過校驗，不等於答案正確/);
 const h=harness();await flush();h.run("changeMode('ai')");assert.deepEqual(h.calls.map(x=>x.url),['/api/status']);assert.equal(h.$('ask').disabled,true);assert.match(h.$('ai-config').textContent,/尚未設定/);h.setHandler(async()=>({ok:true,json:async()=>({aiConfigured:true,simulation:true})}));await h.$('check-config').onclick();assert.match(h.$('ai-config').textContent,/模擬 AI 連線/);assert.match(h.$('ai-config').textContent,/沒有真實模型或金鑰/);assert.ok(h.calls.every(x=>x.url==='/api/status'));
});
