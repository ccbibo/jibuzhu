import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication, sqliteStore } from '../standalone/server.mjs';

async function fixture(t,databasePath=':memory:'){
 let calls=0,closed=false;
 const app=createApplication({databasePath,config:{provider:'deepseek',model:'test-only'},fetcher:async()=>{calls++;throw Error('no external calls');}});
 app.address=()=>({port:4173});const close=()=>{if(!closed){closed=true;app.emit('close');}};t.after(close);
 const jar=new Map();
 const dispatch=(route,body,extra={})=>new Promise(resolve=>{
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url=route;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173',origin:'http://127.0.0.1:4173','content-type':'application/json',cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...extra};
  const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(text){const cookies=this.headers?.['Set-Cookie'];for(const value of Array.isArray(cookies)?cookies:cookies?[cookies]:[]){const pair=value.split(';')[0],index=pair.indexOf('=');jar.set(pair.slice(0,index),pair.slice(index+1));}resolve({status:this.status,headers:this.headers,text,json:()=>JSON.parse(text)});}};app.emit('request',req,res);
 });
 await dispatch('/api/session');return {dispatch,jar,close,calls:()=>calls};
}
const register={email:'Admin@example.com',password:'synthetic-password-123',name:'管理員'};
test('production defaults to protected workspace and auth mutations retain CSRF guards',async t=>{
 const f=await fixture(t);
 assert.equal((await f.dispatch('/')).headers.Location,'/welcome');assert.match((await f.dispatch('/account')).headers.Location,/^\/login/);
 for(const route of ['/api/status','/api/notion','/api/auth/me'])assert.equal((await f.dispatch(route)).status,401);
 for(const headers of [{cookie:''},{origin:'https://evil.example'},{'content-type':'text/plain'}])assert.notEqual((await f.dispatch('/api/auth/register',register,headers)).status,201);
 assert.equal(f.calls(),0);
});
test('registration, normalized login, logout and self-only profiles use real account identities',async t=>{
 const f=await fixture(t);const created=await f.dispatch('/api/auth/register',register);assert.equal(created.status,201);const admin=created.json().user;
 assert.equal(admin.role,'admin');assert.equal(admin.email,'admin@example.com');assert.ok(!/password|salt|token_hash/.test(created.text));assert.match(created.headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);
 const firstToken=f.jar.get('actiondesk_auth');assert.equal((await f.dispatch('/api/auth/logout',{})).status,200);assert.equal((await f.dispatch('/api/auth/me')).status,401);
 assert.equal((await f.dispatch('/api/auth/login',{email:'admin@example.com',password:'wrong-password'})).status,401);
 const login=await f.dispatch('/api/auth/login',{email:'ADMIN@EXAMPLE.COM',password:register.password});assert.equal(login.status,200);assert.notEqual(f.jar.get('actiondesk_auth'),firstToken);
 const member=await f.dispatch('/api/auth/register',{email:'member@example.com',password:register.password,name:'成員'});assert.equal(member.json().user.role,'member');
 assert.equal((await f.dispatch('/api/settings/ai',{approved:true})).status,403);
 const changed=await f.dispatch('/api/auth/profile',{name:'新名字',avatar:'🌱',id:admin.id,role:'admin'});assert.equal(changed.status,200);assert.equal(changed.json().user.role,'member');assert.notEqual(changed.json().user.id,admin.id);
 for(const avatar of ['https://example.com/avatar.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,PHN2Zz4='])assert.equal((await f.dispatch('/api/auth/profile',{avatar})).status,400);
 assert.equal((await f.dispatch('/api/auth/me')).json().user.avatar,'🌱');assert.equal(f.calls(),0);
});
test('password hashes and hashed sessions persist, logout revokes token across restart',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'jibuzhu-auth-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'accounts.sqlite');
 const first=await fixture(t,file);const created=await first.dispatch('/api/auth/register',register);const token=first.jar.get('actiondesk_auth');await first.dispatch('/api/auth/profile',{name:'保存名字',avatar:'🐱'});first.close();
 const db=new DatabaseSync(file);const user=db.prepare('SELECT * FROM local_users').get(),session=db.prepare('SELECT * FROM local_sessions').get();assert.notEqual(user.password_hash,register.password);assert.ok(user.password_salt);assert.notEqual(session.token_hash,token);db.close();
 const second=await fixture(t,file);second.jar.set('actiondesk_auth',token);const me=await second.dispatch('/api/auth/me');assert.equal(me.status,200);assert.equal(me.json().user.id,created.json().user.id);assert.equal(me.json().user.name,'保存名字');
 await second.dispatch('/api/auth/logout',{});second.jar.set('actiondesk_auth',token);assert.equal((await second.dispatch('/api/auth/me')).status,401);
});
test('receipt migration preserves old rows and isolates equal keys by real user ID',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("CREATE TABLE sync_receipts(key TEXT PRIMARY KEY,user_id TEXT NOT NULL,state TEXT NOT NULL,notion_page_id TEXT,notion_url TEXT,updated_at INTEGER NOT NULL); INSERT INTO sync_receipts VALUES('old','legacy','success','page',NULL,0)");
  const store=sqliteStore(db);assert.equal((await store.get('old','legacy')).notion_page_id,'page');
  assert.equal(await store.claim('same','account-a'),true);assert.equal(await store.claim('same','account-b'),true);await store.finish('same','account-a','success',{id:'only-a'});assert.equal((await store.get('same','account-b')).notion_page_id,null);
 }finally{db.close();}
});
