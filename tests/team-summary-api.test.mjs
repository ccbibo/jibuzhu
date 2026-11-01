// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApplication } from '../standalone/server.mjs';
const meeting={title:'全員總覽',meetingDate:'2026-10-31',mode:'rules',transcript:'A：我建議留下備案。'};
async function fixture(t,key='test-key'){
 let calls=0;
 const app=createApplication({requireAccountAuth:false,databasePath:':memory:',config:{model:'test-only',openaiKey:key},fetcher:async(url,init)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(init.body);assert.equal(body.store,false);assert.equal(body.text.format.name,'team_summary');
  return Response.json({status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify({items:[{kind:'suggestion',text:'保留備案供討論。',citations:[{lineIndex:0,quote:'我建議留下備案。'}]}],caveats:[]})}]}]});
 }});
 app.address=()=>({port:4173});t.after(()=>app.emit('close'));
 const dispatch=(route,init={})=>new Promise(resolve=>{const req=Readable.from(init.body?[Buffer.from(init.body)]:[]);req.url=route;req.method=init.method||'GET';req.headers=Object.fromEntries(new Headers({Host:'127.0.0.1:4173',...init.headers}).entries());const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){resolve(new Response(body??null,{status:this.status,headers:this.headers}));}};app.emit('request',req,res);});
 const home=await dispatch('/speakers'),cookie=home.headers.get('set-cookie').split(';')[0];
 const post=(body,headers={})=>dispatch('/api/team-summary',{method:'POST',headers:{Cookie:cookie,Origin:'http://127.0.0.1:4173','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 return {post,calls:()=>calls};
}
test('team summary API requires explicit approval, local session and same origin before provider transmission',async t=>{
 const f=await fixture(t);assert.equal((await f.post({meeting})).status,400);assert.equal((await f.post({meeting,approved:true},{Cookie:''})).status,401);assert.equal((await f.post({meeting,approved:true},{Origin:'https://example.com'})).status,403);assert.equal(f.calls(),0);
 const res=await f.post({meeting,approved:true});assert.equal(res.status,200);const result=await res.json();assert.equal(result.items[0].kind,'suggestion');assert.equal(result.items[0].citations[0].lineIndex,0);assert.equal(result.coverage.complete,true);assert.equal(f.calls(),1);
});
test('team summary API reports unavailable without a key and never fakes model output',async t=>{
 const f=await fixture(t,'');const res=await f.post({meeting,approved:true});assert.equal(res.status,503);assert.equal(f.calls(),0);assert.match((await res.json()).error,/金鑰/);
});
