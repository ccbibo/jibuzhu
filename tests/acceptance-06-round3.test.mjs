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


test('06-r3: source editor starts closed and invalid transcript opens it without sending',async()=>{
 const opening=html.match(/<details\b[^>]*id="source-editor"[^>]*>/)?.[0];assert.ok(opening);assert.ok(!/\bopen\b/.test(opening));const transcript=html.match(/<textarea\b[^>]*id="transcript"[^>]*>/)?.[0];assert.match(transcript,/\brequired\b/);assert.ok(!/\b(readonly|disabled)\b/.test(transcript));
 const h=harness();await flush();assert.ok(!h.$('source-editor').open);h.$('transcript').value='';await h.$('transcript').fire('invalid');assert.equal(h.$('source-editor').open,true);assert.deepEqual(h.calls.map(c=>c.url),['/api/status']);
});
test('06-r3: compact source count follows initial sample, manual edit, import and restored sample',async()=>{
 const h=harness();await flush();assert.equal(h.$('source-count').textContent,h.$('transcript').value.length.toLocaleString()+' 字 · 點此編輯');
 h.$('transcript').value='甲：新原文';await h.$('transcript').fire('input');assert.equal(h.$('source-count').textContent,'5 字 · 點此編輯');assert.equal(h.$('sample-meta').hidden,true);
 const bytes=new TextEncoder().encode('乙：匯入');h.$('source-file').files=[{name:'new.txt',size:bytes.length,arrayBuffer:async()=>bytes.buffer}];await h.$('source-file').fire('change');assert.equal(h.$('source-count').textContent,'4 字 · 點此編輯');assert.equal(h.$('transcript').value,'乙：匯入');h.$('load-example').onclick();assert.equal(h.$('source-count').textContent,h.$('transcript').value.length.toLocaleString()+' 字 · 點此編輯');assert.equal(h.$('sample-meta').hidden,false);assert.ok(h.calls.every(c=>c.url==='/api/status'));
});
test('06-r3: CSS statically separates desktop scroll regions and restores document scrolling at mobile breakpoint',()=>{
 const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];assert.match(css,/--sidebar:174px/);assert.match(css,/body\{[^}]*height:100dvh;overflow:hidden/);assert.match(css,/\.layout\{[^}]*grid-template-columns:300px minmax\(0,1fr\)/);assert.match(css,/\.layout>section\{[^}]*overflow:auto/);assert.match(css,/\.layout>div\{[^}]*overflow:auto/);
 const mobile=css.slice(css.indexOf('@media(max-width:780px)'));assert.match(mobile,/body\{height:auto;min-height:100dvh;overflow:auto/);assert.match(mobile,/\.sidebar\{position:static/);assert.match(mobile,/\.layout\{display:flex;flex-direction:column/);assert.match(mobile,/\.layout>section\{overflow:visible/);assert.match(mobile,/\.layout>div\{overflow:visible/);
});
