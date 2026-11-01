import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplication } from '../standalone/server.mjs';

// Independent production-default account gates. Never disables account auth,
// never loads the real config, and never permits an external provider call.
const origin='http://127.0.0.1:4173';
const password='Audit-only-password-2026!';
async function fixture(t){
 const dir=mkdtempSync(path.join(tmpdir(),'jibuzhu-auth-audit-')),databasePath=path.join(dir,'audit.sqlite');
 let app,providerCalls=0;
 const open=()=>{app=createApplication({databasePath,config:{provider:'openai',model:'synthetic-only',openaiKey:'synthetic-only'},fetcher:async()=>{providerCalls++;throw Error('External calls forbidden by auth audit');}});app.address=()=>({port:4173});};open();
 t.after(()=>{app.emit('close');rmSync(dir,{recursive:true,force:true});});
 function client(){const cookies=new Map();return {
  cookies,
  async request(route,{body,headers={},method=body===undefined?'GET':'POST'}={}){
   return new Promise(resolve=>{const req=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);req.url=route;req.method=method;req.headers={host:'127.0.0.1:4173',origin,'content-type':'application/json',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...headers};const res={writeHead(status,responseHeaders){this.status=status;this.headers=responseHeaders;},end(raw){const hs=this.headers||{};let set=hs['Set-Cookie']||hs['set-cookie']||[];if(!Array.isArray(set))set=[set];for(const item of set){const first=item.split(';')[0],split=first.indexOf('=');cookies.set(first.slice(0,split),first.slice(split+1));}resolve({status:this.status,headers:hs,text:String(raw??''),json:()=>JSON.parse(String(raw??'null'))});}};app.emit('request',req,res);});
  },
  async bootstrap(){return this.request('/api/session');},
  async register(email='audit-a@example.test',name='Audit A'){await this.bootstrap();return this.request('/api/auth/register',{body:{email,password,name}});},
 } ;}
 return {client,databasePath,providerCalls:()=>providerCalls,restart(){app.emit('close');open();}};
}
const userOf=response=>response.json().user;
const noSecrets=response=>{assert.ok(!response.text.includes(password));assert.doesNotMatch(response.text,/passwordHash|password_hash|passwordSalt|password_salt|scrypt\$/i);};

test('auth GATE: production default rejects anonymous workspace APIs without contacting a provider',async t=>{
 const f=await fixture(t),c=f.client();await c.bootstrap();
 for(const route of ['/api/status','/api/auth/me','/api/notion'])assert.equal((await c.request(route)).status,401,route);
 for(const route of ['/api/team-summary','/api/ask','/api/extract','/api/attribution/demo','/api/validate-tasks'])assert.equal((await c.request(route,{body:{}})).status,401,route);
 const home=await c.request('/');assert.equal(home.status,302);assert.match(home.headers.Location||home.headers.location,/welcome/);
 const settings=await c.request('/settings');assert.equal(settings.status,302);assert.match(settings.headers.Location||settings.headers.location,/login/);
 assert.equal(f.providerCalls(),0);
});

test('auth GATE: registration/login/logout rotate sessions and never disclose password material',async t=>{
 const f=await fixture(t),c=f.client();const registered=await c.register();assert.equal(registered.status,201);noSecrets(registered);assert.match(String(registered.headers['Set-Cookie']),/HttpOnly/);assert.match(String(registered.headers['Set-Cookie']),/SameSite=Strict/);
 const firstCookie=c.cookies.get('actiondesk_auth');assert.ok(firstCookie);assert.equal((await c.request('/api/auth/me')).status,200);
 const stale=f.client();for(const pair of c.cookies)stale.cookies.set(...pair);
 assert.equal((await c.request('/api/auth/logout',{body:{}})).status,200);assert.equal((await stale.request('/api/auth/me')).status,401);
 const wrong=await c.request('/api/auth/login',{body:{email:'audit-a@example.test',password:'wrong-password-123'}});assert.equal(wrong.status,401);noSecrets(wrong);
 const login=await c.request('/api/auth/login',{body:{email:'audit-a@example.test',password}});assert.equal(login.status,200);assert.notEqual(c.cookies.get('actiondesk_auth'),firstCookie);noSecrets(login);
 const bytes=readFileSync(f.databasePath);assert.ok(!bytes.includes(Buffer.from(password)));assert.ok(!bytes.includes(Buffer.from(c.cookies.get('actiondesk_auth'))));
});

test('auth GATE: auth writes require same origin, local CSRF session and JSON',async t=>{
 const f=await fixture(t),c=f.client();await c.bootstrap();const body={email:'csrf@example.test',password,name:'CSRF'};
 for(const headers of [{origin:'https://attacker.example'},{cookie:''},{'content-type':'text/plain'},{'sec-fetch-site':'cross-site'}]){
  const result=await c.request('/api/auth/register',{body,headers});assert.ok([400,401,403,415].includes(result.status),JSON.stringify(headers));noSecrets(result);
 }
 assert.equal((await c.request('/api/auth/register',{body})).status,201);
 for(const route of ['/api/auth/profile','/api/auth/logout'])assert.equal((await c.request(route,{body:{name:'stolen'},headers:{origin:'https://attacker.example'}})).status,403);
});

test('auth GATE: profile mutations are account-scoped, survive restart and cannot grant admin',async t=>{
 const f=await fixture(t),a=f.client(),b=f.client();const ra=await a.register(),rb=await b.register('audit-b@example.test','Audit B');assert.equal(ra.status,201);assert.equal(rb.status,201);
 const aId=userOf(ra).id,bId=userOf(rb).id;assert.notEqual(aId,bId);
 const changed=await b.request('/api/auth/profile',{body:{id:aId,userId:aId,name:'Updated B',avatar:'🐱',role:'admin',isAdmin:true}});assert.equal(changed.status,200);noSecrets(changed);
 assert.equal(userOf(await a.request('/api/auth/me')).name,'Audit A');assert.equal(userOf(await b.request('/api/auth/me')).name,'Updated B');assert.equal(userOf(await b.request('/api/auth/me')).role,'member');
 assert.equal((await b.request('/api/settings/ai',{body:{provider:'openai',apiKey:'sk-synthetic-only-1234567890',model:'synthetic',approved:true}})).status,403);
 f.restart();await b.bootstrap();const persisted=await b.request('/api/auth/me');assert.equal(persisted.status,200);assert.equal(userOf(persisted).name,'Updated B');assert.equal(userOf(persisted).avatar,'🐱');noSecrets(persisted);
});

test('auth GATE: avatar rejects URLs/SVG/oversize data without changing stored profile',async t=>{
 const f=await fixture(t),c=f.client();assert.equal((await c.register()).status,201);
 assert.equal((await c.request('/api/auth/profile',{body:{name:'Saved name',avatar:'🌻'}})).status,200);
 for(const avatar of ['https://example.test/photo.png','//example.test/a.png','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=','data:image/png;base64,PHN2Zz48L3N2Zz4=','<svg onload=alert(1)>','data:image/png;base64,'+'A'.repeat(100001)]){
  const result=await c.request('/api/auth/profile',{body:{name:'Should not persist',avatar}});assert.equal(result.status,400,avatar.slice(0,60));noSecrets(result);
 }
 const unchanged=userOf(await c.request('/api/auth/me'));assert.equal(unchanged.name,'Saved name');assert.equal(unchanged.avatar,'🌻');
 const cleared=await c.request('/api/auth/profile',{body:{name:'Saved name',avatar:null}});assert.equal(cleared.status,200);assert.equal(userOf(cleared).avatar,null);
});

test('auth GATE: shipped local entry point explicitly enables authentication',()=>{
 const source=readFileSync(new URL('../standalone/server.mjs',import.meta.url),'utf8');const entry=source.slice(source.indexOf('if (process.argv[1]'));
 assert.match(entry,/createApplication\(\{\s*requireAccountAuth:\s*true\s*\}\)/);
});


test('auth GATE: salted scrypt and hashed expiring sessions are persisted, never raw secrets',async t=>{
 const f=await fixture(t),a=f.client(),b=f.client();assert.equal((await a.register()).status,201);assert.equal((await b.register('second@example.test','Second')).status,201);
 const db=new DatabaseSync(f.databasePath);t.after(()=>db.close());const rows=db.prepare('SELECT password_salt,password_hash FROM local_users ORDER BY email').all();assert.equal(rows.length,2);assert.notEqual(rows[0].password_salt,rows[1].password_salt);assert.notEqual(rows[0].password_hash,rows[1].password_hash);
 for(const row of rows)assert.equal(row.password_hash,scryptSync(password,row.password_salt,64).toString('hex'));
 const token=a.cookies.get('actiondesk_auth');const hashed=createHash('sha256').update(token).digest('hex');assert.ok(db.prepare('SELECT token_hash FROM local_sessions WHERE token_hash=?').get(hashed));assert.equal(db.prepare('SELECT token_hash FROM local_sessions WHERE token_hash=?').get(token),undefined);
 db.prepare('UPDATE local_sessions SET expires_at=? WHERE token_hash=?').run(Date.now()-1000,hashed);assert.equal((await a.request('/api/auth/me')).status,401);
 a.cookies.set('actiondesk_auth','a'.repeat(64));assert.equal((await a.request('/api/auth/me')).status,401);
});

test('auth GATE: valid raster avatar persists while duplicate email and invalid profile are rejected',async t=>{
 const f=await fixture(t),c=f.client();assert.equal((await c.register()).status,201);const duplicate=f.client();await duplicate.bootstrap();assert.equal((await duplicate.request('/api/auth/register',{body:{email:'AUDIT-A@EXAMPLE.TEST',password,name:'Duplicate'}})).status,409);
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=';
 const update=await c.request('/api/auth/profile',{body:{name:'Raster User',avatar:png}});assert.equal(update.status,200);assert.equal(userOf(update).avatar,png);
 for(const name of ['', 'a'.repeat(81),'bad\u0000name'])assert.equal((await c.request('/api/auth/profile',{body:{name}})).status,400);
 assert.equal(userOf(await c.request('/api/auth/me')).name,'Raster User');
});

test('auth GATE: password bounds and preset avatars follow the account contract',async t=>{
 const f=await fixture(t),c=f.client();await c.bootstrap();
 for(const short of ['123456789','x'.repeat(129)])assert.equal((await c.request('/api/auth/register',{body:{email:'bounds@example.test',password:short,name:'Bounds'}})).status,400);
 assert.equal((await c.request('/api/auth/register',{body:{email:'bounds@example.test',password:'1234567890',name:'Bounds'}})).status,201);
 for(let i=0;i<10;i++){const result=await c.request('/api/auth/profile',{body:{avatar:'preset:'+i}});assert.equal(result.status,200);assert.equal(userOf(result).avatar,'preset:'+i);}
 for(const avatar of ['preset:-1','preset:10','preset:0/onerror=alert(1)'])assert.equal((await c.request('/api/auth/profile',{body:{avatar}})).status,400);
});

test('auth GATE: account identity changes clear the prior browser workspace while the same identity preserves it',()=>{
 const storage=new Map(),window={sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};
 const source=readFileSync(new URL('../public/assets/workspace.js',import.meta.url),'utf8');
 vm.runInNewContext(source,{window,Date});const api=window.JibuzhuWorkspace;
 assert.equal(api.setIdentity('account-a'),true);assert.equal(api.saveMeeting({id:'synthetic-meeting',title:'A private source',meetingDate:'2026-11-01',transcript:'A private transcript'}),true);
 assert.equal(api.setIdentity('account-a'),true);assert.equal(api.readMeeting().title,'A private source');
 assert.equal(api.setIdentity('account-b'),true);assert.equal(api.readMeeting(),null);
});
