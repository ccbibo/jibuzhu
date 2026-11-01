// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createApplication } from '../standalone/server.mjs';

// Real request handler dispatch; assets never invoke a provider or require credentials.
function fixture(t){
  let calls=0;const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:{model:'asset-test'},fetcher:async()=>{calls++;throw Error('Static assets must not invoke providers');}});
  app.address=()=>({port:4173});t.after(()=>app.emit('close'));
  const dispatch=(url,method='GET',headers={})=>new Promise(resolve=>{
    const req=Readable.from([]);req.url=url;req.method=method;req.headers={host:'127.0.0.1:4173',...headers};
    const res={headersSent:false,writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},end(body){resolve({status:this.status,headers:this.headers,body});}};app.emit('request',req,res);
  });
  return {dispatch,calls:()=>calls};
}
const assets=[
  ['/assets/meeting-print.png','image/png'],
  ['/assets/fonts/print-fonts.css','text/css; charset=utf-8'],
  ...['bricolage-grotesque','hanken-grotesk','spline-sans-mono'].map(name=>['/assets/fonts/'+name+'.woff2','font/woff2']),
];
test('print assets: five explicit GET routes serve original bytes with correct MIME and no provider access',async t=>{
  const f=fixture(t);
  for(const [url,mime] of assets){
    const res=await f.dispatch(url),expected=readFileSync(new URL('../public'+url,import.meta.url));
    assert.equal(res.status,200,url);assert.equal(res.headers['Content-Type'],mime);assert.equal(res.headers['Content-Length'],expected.length);assert.equal(res.headers['X-Content-Type-Options'],'nosniff');assert.deepEqual(res.body,expected);
    if(url.endsWith('.png'))assert.deepEqual([...res.body.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    if(url.endsWith('.woff2'))assert.equal(res.body.subarray(0,4).toString(),'wOF2');
  }
  assert.equal(f.calls(),0);
});
test('print assets: HEAD keeps byte length and MIME but sends no body',async t=>{
  const f=fixture(t);
  for(const [url,mime] of assets){const res=await f.dispatch(url,'HEAD');assert.equal(res.status,200,url);assert.equal(res.headers['Content-Type'],mime);assert.equal(res.headers['Content-Length'],readFileSync(new URL('../public'+url,import.meta.url)).length);assert.ok(res.body===undefined||res.body.length===0);}
  assert.equal(f.calls(),0);
});
test('print assets: exact allowlist rejects arbitrary files, traversal, suffix tricks and unsupported methods',async t=>{
  const f=fixture(t);
  for(const url of ['/assets/','/assets/missing.png','/assets/meeting-print.png/other','/assets/meeting-print.png%00','/assets/meeting-print.PNG','/assets/fonts/hanken-grotesk-OFL.txt','/assets/fonts/missing.woff2','/assets/fonts/../../standalone/server.mjs','/assets/%2e%2e/%2e%2e/standalone/server.mjs','/assets/%2e%2e%2fstandalone%2fserver.mjs','/assets/%252e%252e%252fstandalone%252fserver.mjs','/assets/fonts/../../../.dev.vars','/package.json']){
    const res=await f.dispatch(url);assert.equal(res.status,404,url);assert.equal(res.headers['Content-Type'],'application/json; charset=utf-8');assert.equal(JSON.parse(res.body).error,'找不到此頁面。');
  }
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS'])assert.equal((await f.dispatch('/assets/meeting-print.png',method)).status,404,method);
  assert.equal(f.calls(),0);
});
test('print assets: host validation still runs before static routing and API authentication is unchanged',async t=>{
  const f=fixture(t);
  for(const host of ['evil.test','localhost:4173','127.0.0.1:4174'])assert.equal((await f.dispatch('/assets/meeting-print.png','GET',{host})).status,403,host);
  const status=await f.dispatch('/api/status');assert.equal(status.status,401);assert.equal(f.calls(),0);
});
