// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApplication} from '../standalone/server.mjs';
async function fixture(t,simulation=false){
 const dir=mkdtempSync(path.join(tmpdir(),'jibuzhu-key-test-'));const file=path.join(dir,'.dev.vars');writeFileSync(file,'NOTION_TOKEN=synthetic-notion-only\n');
 const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:{model:'test-model'},configPath:file,simulation,fetcher:async()=>{throw Error('Settings must never transmit');}});app.address=()=>({port:4173});
 t.after(()=>{app.emit('close');rmSync(dir,{recursive:true,force:true});});
 const dispatch=(route,init={})=>new Promise(resolve=>{let req=Readable.from(init.body?[Buffer.from(init.body)]:[]);req.url=route;req.method=init.method||'GET';req.headers=Object.fromEntries(new Headers({Host:'127.0.0.1:4173',...init.headers}).entries());let res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){resolve(new Response(body??null,{status:this.status,headers:this.headers}));}};app.emit('request',req,res);});
 const home=await dispatch('/speakers');let cookie=home.headers.get('set-cookie').split(';')[0];
 const post=(body,headers={})=>dispatch('/api/settings/ai',{method:'POST',headers:{Cookie:cookie,Origin:'http://127.0.0.1:4173','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 return {post,file,dispatch,cookie};
}
const body={approved:true,apiKey:'sk-synthetic-test-only-1234567890',model:'gpt-4o-mini'};
test('local AI setup requires consent, same origin and session; rejects newline injection',async t=>{const f=await fixture(t);for(const b of [{...body,approved:false},{...body,apiKey:body.apiKey+'\nNOTION_TOKEN=bad'},{...body,model:'model\nKEY=bad'}])assert.equal((await f.post(b)).status,400);assert.equal((await f.post(body,{Cookie:''})).status,401);assert.equal((await f.post(body,{Origin:'https://example.com'})).status,403);assert.equal(readFileSync(f.file,'utf8'),'NOTION_TOKEN=synthetic-notion-only\n');});
test('local setup persists privately without exposing keys and activates runtime config',async t=>{const f=await fixture(t);const r=await f.post(body);assert.equal(r.status,200);assert.ok(!(await r.text()).includes(body.apiKey));const vars=readFileSync(f.file,'utf8');assert.match(vars,/NOTION_TOKEN=synthetic-notion-only/);assert.ok(vars.includes(body.apiKey));assert.equal(statSync(f.file).mode&0o777,0o600);const status=await f.dispatch('/api/status',{headers:{Cookie:f.cookie}});const text=await status.text();assert.ok(text.includes('"aiConfigured":true'));assert.ok(!text.includes(body.apiKey));});
test('simulation setup never writes real credentials',async t=>{const f=await fixture(t,true);assert.equal((await f.post(body)).status,400);assert.equal(readFileSync(f.file,'utf8'),'NOTION_TOKEN=synthetic-notion-only\n');});
test('provider selection persists independently and never reuses the other provider credential',async t=>{
 const f=await fixture(t);const ds={...body,provider:'deepseek',apiKey:'sk-synthetic-deepseek-only-123456',model:'deepseek-flash'};
 assert.equal((await f.post(ds)).status,200);let text=readFileSync(f.file,'utf8');assert.match(text,/AI_PROVIDER=deepseek\n/);assert.ok(text.includes('DEEPSEEK_API_KEY='+ds.apiKey));
 assert.equal((await f.post({...body,provider:'openai'})).status,200);text=readFileSync(f.file,'utf8');assert.match(text,/AI_PROVIDER=openai\n/);assert.equal((text.match(/^AI_PROVIDER=/gm)||[]).length,1);assert.ok(text.includes('DEEPSEEK_API_KEY='+ds.apiKey));assert.ok(text.includes('OPENAI_API_KEY='+body.apiKey));
 const status=await f.dispatch('/api/status',{headers:{Cookie:f.cookie}});const current=await status.json();assert.equal(current.provider,'openai');assert.equal(current.providerLabel,'OpenAI');assert.equal(current.aiConfigured,true);assert.ok(!JSON.stringify(current).includes(ds.apiKey));
 assert.equal((await f.post({...ds,provider:'unknown'})).status,400);assert.equal(readFileSync(f.file,'utf8'),text);
});
