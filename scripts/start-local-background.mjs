/** Start the local product independently of the terminal / QA tool session. */
import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync,writeFileSync,appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.ACTIONDESK_PORT||4173);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('ACTIONDESK_PORT 必須介於 1024 與 65535');
const origin='http://127.0.0.1:'+port;
async function ready(){try{const response=await fetch(origin+'/api/session',{signal:AbortSignal.timeout(1200)});if(!response.ok)return false;const result=await response.json();return typeof result.authenticated==='boolean';}catch{return false;}}
if(await ready()){console.log('記補住已在執行：'+origin+'/welcome');process.exit(0);}
const outputs=path.join(root,'outputs');mkdirSync(outputs,{recursive:true});
const log=path.join(outputs,'local-server.log');appendFileSync(log,'\n[local start '+new Date().toISOString()+']\n');
const fd=openSync(log,'a',0o600);
const child=spawn(process.execPath,['--experimental-strip-types',path.join(root,'standalone/server.mjs')],{cwd:root,detached:true,stdio:['ignore',fd,fd],env:{...process.env,ACTIONDESK_PORT:String(port)}});
closeSync(fd);
let failed=false;child.once('error',()=>{failed=true;});child.unref();
if(child.pid)writeFileSync(path.join(outputs,'local-server.pid'),String(child.pid)+'\n',{mode:0o600});
for(let attempt=0;attempt<30;attempt++){if(failed)break;if(await ready()){console.log('記補住背景服務已啟動：'+origin+'/welcome');process.exit(0);}await new Promise(resolve=>setTimeout(resolve,200));}
console.error('啟動未成功，請查看 outputs/local-server.log；沒有停止或取代其他服務。');process.exit(1);
