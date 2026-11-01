// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createApplication } from '../standalone/server.mjs';
const meeting={title:'security synthetic',meetingDate:'2026-10-31',mode:'rules',transcript:'小林：我會明天提交簡報。'};
function fixture(t,configured=false){
  let calls=0;
  const config={model:'test-security',...(configured?{openaiKey:'synthetic-ai-key',notionToken:'synthetic-notion-token',dataSourceId:'synthetic-source'}:{})};
  const app=createApplication({requireAccountAuth:false,config,databasePath:':memory:',fetcher:async()=>{calls++;throw new Error('synthetic provider error');}});
  app.address=()=>({port:4173});t.after(()=>app.emit('close'));
  const origin='http://127.0.0.1:4173';
  async function dispatch(url='/',options={}){
    const req=Readable.from(options.body===undefined?[]:[Buffer.from(options.body)]);
    req.url=url;req.method=options.method||'GET';req.headers=Object.fromEntries(new Headers({Host:'127.0.0.1:4173',...options.headers}));
    return await new Promise(resolve=>{const res={headersSent:false,writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},end(body){resolve(new Response(body??null,{status:this.status,headers:this.headers}));}};app.emit('request',req,res);});
  }
  return {dispatch,origin,calls:()=>calls,async cookie(){return (await dispatch('/')).headers.get('set-cookie').split(';')[0];}};
}
test('03 session is HttpOnly Strict, absent/forged/cross-instance sessions rejected',async t=>{
  const f=fixture(t),g=fixture(t);const home=await f.dispatch('/');const cookie=home.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(home.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  for(const session of ['', 'actiondesk_session='+'0'.repeat(64),await g.cookie()])assert.equal((await f.dispatch('/api/status',{headers:{Cookie:session}})).status,401);
});
test('03 host/origin/content-type guards prevent all provider calls',async t=>{
  const f=fixture(t,true),cookie=await f.cookie();
  for(const endpoint of ['/api/extract','/api/sync','/api/ask','/api/verify']){
    const headers={Cookie:cookie,Origin:f.origin,'Content-Type':'application/json'};
    for(const [overrides,status] of [[{Host:'evil.example'},403],[{Origin:'https://evil.example'},403],[{Origin:'null'},403],[{Origin:''},403],[{'Sec-Fetch-Site':'cross-site'},403],[{'Content-Type':'text/plain'},415]]){
      assert.equal((await f.dispatch(endpoint,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify({...meeting,mode:'ai'})})).status,status,endpoint+JSON.stringify(overrides));
    }
  }
  assert.equal(f.calls(),0);
});
test('03 oversized and malformed bodies rejected before providers',async t=>{
  const f=fixture(t,true),cookie=await f.cookie();const headers={Cookie:cookie,Origin:f.origin,'Content-Type':'application/json'};
  for(const endpoint of ['/api/extract','/api/ask','/api/verify'])for(const body of ['{bad',JSON.stringify({...meeting,transcript:'x'.repeat(160001)})])assert.equal((await f.dispatch(endpoint,{method:'POST',headers,body})).status,400);
  assert.equal(f.calls(),0);
});
test('03 fixed static routes expose no environment, sources or SQLite files; status excludes synthetic secrets',async t=>{
  const f=fixture(t,true),cookie=await f.cookie();
  for(const route of ['/.dev.vars','/.env','/package.json','/standalone/server.mjs','/outputs/actiondesk.sqlite','/../.dev.vars','/%2e%2e/.dev.vars','/lib/providers.ts'])assert.equal((await f.dispatch(route,{headers:{Cookie:cookie}})).status,404,route);
  const status=await (await f.dispatch('/api/status',{headers:{Cookie:cookie}})).json();
  assert.equal(status.aiConfigured,true);assert.equal(status.notionConfigured,true);
  assert.equal(JSON.stringify(status).includes('synthetic-ai-key'),false);assert.equal(JSON.stringify(status).includes('synthetic-notion-token'),false);
});
test('03 task escaping and Notion URL allowlist reject HTML and unsafe schemes',()=>{
  const html=readFileSync(new URL('../standalone/index.html',import.meta.url),'utf8');
  const escapeCode=html.match(/const escapeHTML =[^\n]+/)[0];const safeCode=html.match(/function safeUrl\(url\)\{[^\n]+/)[0];
  const sandbox={URL};vm.createContext(sandbox);vm.runInContext(escapeCode+'\n'+safeCode+'\nglobalThis.escapeHTML=escapeHTML;',sandbox);
  assert.equal(sandbox.escapeHTML('<img src=x onerror="attack()">'), '&lt;img src=x onerror=&quot;attack()&quot;&gt;');
  for(const url of ['javascript:attack()','https://notion.so.evil.example','https://evilnotion.so','data:text/html,test'])assert.equal(sandbox.safeUrl(url),null);
  assert.ok(sandbox.safeUrl('https://www.notion.so/test'));
});
test('03 strict JSON media type rejects prefix counterexample',async t=>{
  const f=fixture(t),cookie=await f.cookie();
  const res=await f.dispatch('/api/extract',{method:'POST',headers:{Cookie:cookie,Origin:f.origin,'Content-Type':'application/json-pwn'},body:JSON.stringify(meeting)});
  assert.equal(res.status,415);
  assert.equal((await f.dispatch('/api/extract',{method:'POST',headers:{Cookie:cookie,Origin:f.origin,'Content-Type':'Application/JSON; charset=utf-8'},body:JSON.stringify(meeting)})).status,200);
});
test('03 ask and verify require sessions; unauthenticated requests never call providers',async t=>{
  const f=fixture(t,true);
  for(const route of ['/api/ask','/api/verify'])assert.equal((await f.dispatch(route,{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json'},body:JSON.stringify({meeting,question:'誰提交簡報？',speaker:''})})).status,401);
  assert.equal(f.calls(),0);
});
test('03 ask and extract share five-per-minute AI limit and rule extraction stays available',async t=>{
  const f=fixture(t,true),cookie=await f.cookie();const headers={Cookie:cookie,Origin:f.origin,'Content-Type':'application/json'};
  for(let i=0;i<5;i++){
    const route=i%2?'/api/extract':'/api/ask';
    const body=i%2?{...meeting,mode:'ai'}:{meeting,question:'誰提交簡報？',speaker:''};
    assert.equal((await f.dispatch(route,{method:'POST',headers,body:JSON.stringify(body)})).status,502);
  }
  assert.equal(f.calls(),5);
  for(const route of ['/api/ask','/api/extract']){
    const body=route.endsWith('ask')?{meeting,question:'誰提交簡報？',speaker:''}:{...meeting,mode:'ai'};
    const res=await f.dispatch(route,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(res.status,429);assert.equal(res.headers.get('retry-after'),'60');
  }
  assert.equal(f.calls(),5);
  assert.equal((await f.dispatch('/api/extract',{method:'POST',headers,body:JSON.stringify(meeting)})).status,200);
});
test('03 unconfigured ask is 503 and verify refuses unapproved or stale input',async t=>{
  const f=fixture(t),cookie=await f.cookie();const headers={Cookie:cookie,Origin:f.origin,'Content-Type':'application/json'};
  assert.equal((await f.dispatch('/api/ask',{method:'POST',headers,body:JSON.stringify({meeting,question:'誰提交簡報？',speaker:''})})).status,503);
  for(const body of [{meeting,approved:false},{meeting,approved:true,meetingId:'stale',tasks:[]}])assert.equal((await f.dispatch('/api/verify',{method:'POST',headers,body:JSON.stringify(body)})).status,400);
  assert.equal(f.calls(),0);
});
