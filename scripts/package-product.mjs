/** Positive-manifest product export. No original Git history or private QA records. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const release=path.join(root,'outputs','release','jibuzhu-'+new Date().toISOString().replace(/[^0-9]/g,'').slice(0,17));
if(fs.existsSync(release))throw Error('Release destination already exists');fs.mkdirSync(release,{recursive:true});
const exact=['README.md','.gitignore','.dev.vars.example','Start_記補住.command','Start_ActionDesk.command','scripts/simulation-server.mjs','scripts/start-local-background.mjs','scripts/package-product.mjs','docs/index.html','docs/verification.md','docs/acceptance/notion-owner.md','docs/governance/夜間驗收門檻.md','docs/governance/協作與上下文隔離規範.md','data/evaluation/情境測例.json'];
const libraries=['attribution','local-auth','manager-board','meeting-qa','notion-attribution','notion-verify','providers','recall-engine','server-sync','task-engine','task-types','team-summary'];
for(const name of libraries)exact.push('lib/'+name+'.ts');
function copy(relative){const source=path.join(root,relative),stat=fs.lstatSync(source);if(stat.isSymbolicLink())throw Error('Symlink excluded: '+relative);if(stat.isDirectory()){for(const name of fs.readdirSync(source))copy(path.join(relative,name));return;}if(!stat.isFile())throw Error('Not a regular file: '+relative);const target=path.join(release,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);fs.chmodSync(target,stat.mode&0o777);}
for(const entry of [...exact,'standalone','public','tests','docs/assets'])copy(entry);
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
fs.writeFileSync(path.join(release,'package.json'),JSON.stringify({name:pkg.name,version:pkg.version,private:true,description:'記補住：以人物與原文為中心的本機會議助手',type:'module',engines:{node:'>=24.0.0'},scripts:{start:'node --experimental-strip-types standalone/server.mjs','start:local':'node --experimental-strip-types standalone/server.mjs','start:background':'node scripts/start-local-background.mjs',test:'node --experimental-strip-types --test tests/*.test.mjs',demo:'node --experimental-strip-types scripts/simulation-server.mjs'}},null,2)+'\n');
function files(dir,prefix=''){return fs.readdirSync(dir).flatMap(name=>{const rel=path.join(prefix,name),full=path.join(dir,name);return fs.statSync(full).isDirectory()?files(full,rel):[rel];});}
const hashes=files(release).map(file=>({file,sha256:createHash('sha256').update(fs.readFileSync(path.join(release,file))).digest('hex')}));
fs.writeFileSync(path.join(release,'PRODUCT_MANIFEST.json'),JSON.stringify({version:pkg.version,exportedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),scope:'Standalone desktop product; no source Git history, runtime accounts, secrets or private QA documents',files:hashes},null,2)+'\n');
fs.writeFileSync(path.join(root,'outputs','latest-release.json'),JSON.stringify({release},null,2)+'\n');console.log(release);
