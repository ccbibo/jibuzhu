import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createApplication} from '../standalone/server.mjs';

test('showcase: synthetic person navigation, one-time adoption and preview never transmit data',()=>{
 const html=readFileSync(new URL('../docs/index.html',import.meta.url),'utf8');
 class E{constructor(){this.children=[];this.dataset={};this.style={};this.attrs={};this.disabled=false;this.hidden=false;this.textContent='';}append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}setAttribute(k,v){this.attrs[k]=v;}}
 const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new E()]));
 elements.get('local-product').hidden=true;
 const tabs=['summary','compare','open'].map(view=>{const e=new E();e.dataset.view=view;return e;});
 const document={getElementById:id=>elements.get(id),createElement:()=>new E(),querySelectorAll:()=>tabs};
 vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{document,location:{hostname:'example.test'},Map,fetch:()=>{throw Error('Showcase must not transmit');}});
 assert.equal(elements.get('demo-roster').children.length,5);assert.equal(elements.get('demo-adopt').disabled,true);
 elements.get('demo-roster').children[1].onclick();assert.match(elements.get('demo-answer').textContent,/承諾/);
 elements.get('demo-adopt').onclick();elements.get('demo-adopt').onclick();assert.equal(elements.get('demo-tasks').children.length,1);
 elements.get('demo-preview').onclick();assert.equal(elements.get('demo-preview-box').hidden,false);assert.match(elements.get('demo-preview-box').textContent,/沒有對外寫入/);
 tabs[1].onclick();assert.match(elements.get('demo-answer').textContent,/不能推斷/);assert.equal(elements.get('local-product').hidden,true);
});

test('showcase: public page and every local showcase asset load without a product account',async t=>{
 const app=createApplication({config:{provider:'deepseek',model:'synthetic'},databasePath:':memory:'});
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.close(resolve)));
 const origin='http://127.0.0.1:'+app.address().port;
 const page=await fetch(origin+'/showcase/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/connect-src 'none'/);
 const html=await page.text();const refs=[...html.matchAll(/(?:src|href)="(assets\/[^"#]+)"/g)].map(m=>m[1]);
 for(const ref of new Set([...refs,'assets/fonts/hanken-grotesk.woff2'])){const response=await fetch(origin+'/showcase/'+ref);assert.equal(response.status,200,ref);}
 assert.equal((await fetch(origin+'/speakers',{redirect:'manual'})).status,302);
});
