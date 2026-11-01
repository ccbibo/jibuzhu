import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
class Element {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.value='';this.dataset={};this.listeners={};this.attributes={};this.style={};this._text='';this.classList={add(){},remove(){}};}
 set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
 append(...items){this.children.push(...items);}prepend(...items){this.children.unshift(...items);}replaceChildren(...items){this._text='';this.children=[...items];}
 setAttribute(key,value){this.attributes[key]=value;}addEventListener(type,fn){this.listeners[type]=fn;}focus(){}scrollIntoView(){}reportValidity(){return true;}setCustomValidity(){}remove(){}
}
const inline=html=>html.match(/<script>([\s\S]*?)<\/script>/)[1];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(html=''){
 const storage=new Map(),elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
 const header=new Element('header'),body=new Element('body');const window={sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},addEventListener(){}};
 const document={getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),querySelector:()=>header,addEventListener(){},body};
 const context=vm.createContext({window,document,Date,URL,AbortController,TextDecoder,Blob,setTimeout:()=>0,console,location:{pathname:'/',search:'',origin:'http://127.0.0.1:4173',replace(){},assign(){}}});
 vm.runInContext(read('public/assets/workspace.js'),context);return {storage,elements,window,document,context,api:window.JibuzhuWorkspace};
}
const privateMeeting={id:'private-a',title:'PRIVATE A TITLE',meetingDate:'2026-11-01',transcript:'PRIVATE A TRANSCRIPT',mode:'rules'};

test('auth UI GATE: reload into another user never exposes the old workspace before or after auth resolves',async()=>{
 const html=read('standalone/recall.html'),f=setup(html);f.api.setIdentity('user-a');f.api.saveMeeting(privateMeeting);
 let release;f.context.fetch=async url=>url==='/api/auth/me'?new Promise(resolve=>release=resolve):{ok:true,json:async()=>({aiConfigured:false})};
 vm.runInContext(read('public/assets/account.js'),f.context);
 assert.equal(f.api.readMeeting(),null);assert.equal(f.api.saveMeeting({...privateMeeting,title:'blocked write'}),false);
 vm.runInContext(inline(html),f.context);assert.ok(!f.elements.get('transcript').value.includes('PRIVATE A'));assert.ok(!f.elements.get('meeting-title').value.includes('PRIVATE A'));
 release({ok:true,status:200,json:async()=>({user:{id:'user-b',name:'User B'}})});await f.window.JibuzhuAuthReady;await flush();
 assert.ok(!f.elements.get('transcript').value.includes('PRIVATE A'));assert.ok(!f.elements.get('meeting-title').value.includes('PRIVATE A'));assert.ok(![...f.storage.values()].join('').includes('PRIVATE A'));
});

test('auth UI GATE: same-user reload restores private source only after the identity check',async()=>{
 const html=read('standalone/recall.html'),f=setup(html);f.api.setIdentity('user-a');f.api.saveMeeting(privateMeeting);let release;
 f.context.fetch=async url=>url==='/api/auth/me'?new Promise(resolve=>release=resolve):{ok:true,json:async()=>({aiConfigured:false})};vm.runInContext(read('public/assets/account.js'),f.context);vm.runInContext(inline(html),f.context);
 assert.equal(f.elements.get('transcript').value,'');release({ok:true,status:200,json:async()=>({user:{id:'user-a',name:'User A'}})});await f.window.JibuzhuAuthReady;await flush();assert.equal(f.elements.get('transcript').value,privateMeeting.transcript);assert.equal(f.elements.get('meeting-title').value,privateMeeting.title);
});

test('auth UI GATE: meeting-local profiles whitelist fields and sanitize URL/SVG without changing person IDs',()=>{
 const f=setup();f.api.saveMeeting(privateMeeting);const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=';
 const profiles=[{id:'person:one',displayName:'Local display',avatarIndex:4,image:png,role:'admin',personId:'forged',token:'secret'},...['https://example.test/a.png','//example.test/a.png','data:image/svg+xml;base64,PHN2Zz4=','<svg/>','data:image/png;base64,'+'A'.repeat(100001)].map((image,i)=>({id:'person:bad-'+i,displayName:'Untrusted',avatarIndex:99,image}))];
 assert.equal(f.api.saveReview(privateMeeting.id,{profiles},'speakers'),true);const saved=f.api.readReview(privateMeeting.id,'speakers');assert.equal(saved.profiles[0].id,'person:one');assert.equal(saved.profiles[0].displayName,'Local display');assert.equal(saved.profiles[0].image,png);assert.deepEqual(Object.keys(saved.profiles[0]).sort(),['avatarIndex','displayName','id','image']);for(const profile of saved.profiles.slice(1)){assert.equal(profile.image,null);assert.equal(profile.avatarIndex,0);}assert.ok(!JSON.stringify(saved).includes('secret'));
 assert.equal(f.api.saveReview(privateMeeting.id,{profiles:Array.from({length:120},(_,i)=>({id:String(i),displayName:'Person'}))},'speakers'),true);assert.equal(f.api.saveReview(privateMeeting.id,{profiles:Array.from({length:121},(_,i)=>({id:String(i)}))},'speakers'),false);assert.equal(f.api.readReview(privateMeeting.id,'speakers').profiles.length,120);
});

test('auth UI GATE: account editor submits name/avatar to the persistent profile endpoint, without identity or authority fields',async()=>{
 const html=read('standalone/account.html'),f=setup(html),calls=[];f.window.JibuzhuAuthReady=Promise.resolve({id:'user-a',name:'User A',email:'a@example.test',role:'member',avatar:'preset:0'});
 f.context.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({user:{id:'user-a',name:'Updated A',email:'a@example.test',role:'member',avatar:'preset:3'}})};};
 vm.runInContext(inline(html),f.context);await flush();f.elements.get('name').value='Updated A';f.elements.get('choices').children[3].onclick();await f.elements.get('profile-form').onsubmit({preventDefault(){}});
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/auth/profile');assert.deepEqual(JSON.parse(calls[0].options.body),{name:'Updated A',avatar:'preset:3'});assert.equal(calls[0].options.credentials,'same-origin');assert.match(f.elements.get('status').textContent,/已儲存/);
});

test('auth UI GATE: unauthenticated reload clears old private state and never initializes recall',async()=>{
 const html=read('standalone/recall.html'),f=setup(html);f.api.setIdentity('user-a');f.api.saveMeeting(privateMeeting);let redirected;
 f.context.location.replace=value=>redirected=value;f.context.fetch=async()=>({ok:false,status:401});vm.runInContext(read('public/assets/account.js'),f.context);vm.runInContext(inline(html),f.context);assert.equal(await f.window.JibuzhuAuthReady,null);await flush();
 assert.match(redirected,/^\/login\?next=/);assert.equal(f.elements.get('transcript').value,'');assert.ok(![...f.storage.values()].join('').includes('PRIVATE A'));
});

test('auth UI GATE: every meeting page loads identity locking before its inline workspace code',()=>{
 for(const filename of ['standalone/recall.html','standalone/index.html','standalone/attribution.html']){
  const html=read(filename),workspace=html.indexOf('<script src="/assets/workspace.js"'),account=html.indexOf('<script src="/assets/account.js"'),script=html.indexOf('<script>');assert.ok(workspace>=0&&account>workspace&&script>account,filename);
 }
});

test('release QA: delayed AI failure cannot replace status after recall conditions change',async()=>{
 const html=read('standalone/recall.html'),f=setup(html);f.context.fetch=async()=>({ok:true,json:async()=>({aiConfigured:true,provider:'openai',model:'synthetic'})});
 vm.runInContext(inline(html),f.context);await flush();
 let resolve;f.context.fetch=()=>new Promise(r=>resolve=r);
 vm.runInContext("$('question').value='原問題';globalThis.pending=askAI();",f.context);
 vm.runInContext("$('question').value='新問題';invalidate({target:$('question')});",f.context);
 const status=f.elements.get('status').textContent;
 resolve({ok:false,status:502,json:async()=>({error:'OLD REQUEST FAILED'})});await f.context.pending;
 assert.equal(f.elements.get('status').textContent,status,'obsolete error must not overwrite current UI');
});

test('release QA: obsolete 409 cannot clear a newer recall AI answer',async()=>{
 const html=read('standalone/recall.html'),f=setup(html);const configured={aiConfigured:true,provider:'openai',model:'synthetic'};
 f.context.fetch=async()=>({ok:true,json:async()=>configured});vm.runInContext(inline(html),f.context);await flush();
 let resolve;f.context.fetch=()=>new Promise(r=>resolve=r);vm.runInContext("$('question').value='原問題';globalThis.pending=askAI();",f.context);
 vm.runInContext("invalidate({target:$('question')});renderAI({mode:'ai',question:'新問題',claims:[],caveats:[]});",f.context);
 assert.equal(f.elements.get('export-panel').hidden,false);
 f.context.fetch=async()=>({ok:true,json:async()=>configured});resolve({ok:false,status:409,json:async()=>({error:'changed'})});await f.context.pending;
 assert.equal(f.elements.get('export-panel').hidden,false,'obsolete response must preserve newer answer/export');
});

test('release QA: avatar choice during profile save cannot unlock concurrent profile writes',async()=>{
 const html=read('standalone/account.html'),f=setup(html);f.window.JibuzhuAuthReady=Promise.resolve({id:'user-a',name:'User A',email:'a@example.test',role:'member',avatar:'preset:0'});
 let resolve,calls=0;f.context.fetch=()=>{calls++;return new Promise(r=>resolve=r);};vm.runInContext(inline(html),f.context);await flush();
 const pending=f.elements.get('profile-form').onsubmit({preventDefault(){}});assert.equal(calls,1);assert.equal(f.elements.get('save').disabled,true);
 f.elements.get('choices').children[3].onclick();const disabled=f.elements.get('save').disabled;
 resolve({ok:true,json:async()=>({user:{id:'user-a',name:'User A',avatar:'preset:0'}})});await pending;
 assert.equal(disabled,true,'save must remain locked while the first profile mutation is unresolved');
});

test('release QA: 409 recheck finishing after a condition change cannot clear the newer answer',async()=>{
 const html=read('standalone/recall.html'),f=setup(html),configured={aiConfigured:true,provider:'openai',model:'synthetic'};
 f.context.fetch=async()=>({ok:true,json:async()=>configured});vm.runInContext(inline(html),f.context);await flush();
 let resolveStatus;f.context.fetch=async url=>url==='/api/status'?new Promise(r=>resolveStatus=r):{ok:false,status:409,json:async()=>({error:'changed'})};
 vm.runInContext("$('question').value='原問題';globalThis.pending=askAI();",f.context);await flush();assert.equal(typeof resolveStatus,'function');
 vm.runInContext("invalidate({target:$('question')});renderAI({mode:'ai',question:'新問題',claims:[],caveats:[]});",f.context);
 resolveStatus({ok:true,json:async()=>configured});await f.context.pending;
 assert.equal(f.elements.get('export-panel').hidden,false,'configuration recheck must not let an obsolete request clear new results');
});
