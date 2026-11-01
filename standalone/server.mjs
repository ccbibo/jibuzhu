import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractRules, validateMeeting, validateTasks, meetingKey, InputError } from '../lib/task-engine.ts';
import { extractAI, getNotionSchema, ProviderError, assertAiConsent } from '../lib/providers.ts';
import { syncTasks } from '../lib/server-sync.ts';
import { askMeeting } from '../lib/meeting-qa.ts';
import { verifyTasks } from '../lib/notion-verify.ts';
import { recallMeeting } from '../lib/recall-engine.ts';
import { buildAttribution } from '../lib/attribution.ts';
import { buildManagerBoard } from '../lib/manager-board.ts';
import { summarizeTeam } from '../lib/team-summary.ts';
import { previewNotionAttribution } from '../lib/notion-attribution.ts';
import { localAuth, authCookie, cookieValue } from '../lib/local-auth.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Exact public assets only; request paths never become filesystem paths.
const publicAssets = new Map([
  ...['meeting-avatars.png','workspace.jpg','showcase-font.css','fonts/hanken-grotesk.woff2','favicon.svg'].map(name=>['/showcase/assets/'+name,['docs/assets/'+name,name.endsWith('.svg')?'image/svg+xml':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.woff2')?'font/woff2':name.endsWith('.jpg')?'image/jpeg':'image/png']]),
  ['/assets/account.js', ['public/assets/account.js', 'text/javascript; charset=utf-8']],
  ['/assets/workspace.js', ['public/assets/workspace.js', 'text/javascript; charset=utf-8']],
  ['/assets/meeting-print.png', ['public/assets/meeting-print.png', 'image/png']],
  ['/assets/meeting-avatars.png', ['public/assets/meeting-avatars.png', 'image/png']],
  ['/assets/fonts/print-fonts.css', ['public/assets/fonts/print-fonts.css', 'text/css; charset=utf-8']],
  ...['bricolage-grotesque', 'hanken-grotesk', 'spline-sans-mono'].map(name =>
    [`/assets/fonts/${name}.woff2`, [`public/assets/fonts/${name}.woff2`, 'font/woff2']]),
]);
export function loadConfig() {
  const keys = ['AI_PROVIDER', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'NOTION_TOKEN', 'NOTION_DATA_SOURCE_ID', 'NOTION_CLAIM_PAGE_ID'];
  const local = {};
  const vars = path.join(root, '.dev.vars');
  if (existsSync(vars)) {
    for (const line of readFileSync(vars, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && keys.includes(m[1])) local[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const get = key => process.env[key] || local[key] || undefined;
  const provider=get('AI_PROVIDER')||'openai';
  if(!['openai','deepseek'].includes(provider))throw new Error('AI_PROVIDER 僅支援 openai 或 deepseek');
  return { provider, deepseekKey:get('DEEPSEEK_API_KEY'), openaiKey: get('OPENAI_API_KEY'), model: provider==='deepseek'?(get('DEEPSEEK_MODEL')||'deepseek-flash'):(get('OPENAI_MODEL') || 'gpt-4o-mini'), notionToken: get('NOTION_TOKEN'), dataSourceId: get('NOTION_DATA_SOURCE_ID'), claimPageId: get('NOTION_CLAIM_PAGE_ID') };
}
export function sqliteStore(db) {
  if(db.prepare('PRAGMA table_info(sync_receipts)').all().find(column=>column.name==='user_id')?.pk===0){
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE sync_receipts RENAME TO legacy_sync_receipts;
      CREATE TABLE sync_receipts (key TEXT NOT NULL,user_id TEXT NOT NULL,state TEXT NOT NULL,notion_page_id TEXT,notion_url TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(key,user_id));
      INSERT INTO sync_receipts SELECT key,user_id,state,notion_page_id,notion_url,updated_at FROM legacy_sync_receipts;
      DROP TABLE legacy_sync_receipts; COMMIT;`);
  }
  return {
    get: async (key, user) => db.prepare('SELECT state, notion_page_id, notion_url FROM sync_receipts WHERE key = ? AND user_id = ?').get(key, user) ?? null,
    claim: async (key, user) => db.prepare("INSERT INTO sync_receipts (key,user_id,state,updated_at) VALUES (?,?,'pending',?) ON CONFLICT(key,user_id) DO UPDATE SET state='pending',updated_at=excluded.updated_at WHERE sync_receipts.state='failed'").run(key,user,Date.now()).changes === 1,
    finish: async (key,user,state,page) => { db.prepare('UPDATE sync_receipts SET state=?,notion_page_id=?,notion_url=?,updated_at=? WHERE key=? AND user_id=?').run(state,page?.id??null,page?.url??null,Date.now(),key,user); },
  };
}
export function createApplication({config = loadConfig(), databasePath = path.join(root,'outputs','actiondesk.sqlite'), fetcher = fetch, simulation = false, configPath = path.join(root,'.dev.vars'), requireAccountAuth = true} = {}) {
  if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), {recursive:true});
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE IF NOT EXISTS sync_receipts (key TEXT NOT NULL,user_id TEXT NOT NULL,state TEXT NOT NULL,notion_page_id TEXT,notion_url TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(key,user_id))');
  db.exec('PRAGMA busy_timeout=5000');
  const accounts=localAuth(db);
  const receipts = sqliteStore(db);
  const session = randomBytes(32).toString('hex');
  let recent = [];
  let summaryInFlight = false;
  let authAttempts=[];
  const csrfCookie=`actiondesk_session=${session}; HttpOnly; SameSite=Strict; Path=/`;
  function authorized(req) {
    const cookie = req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('actiondesk_session='))?.slice('actiondesk_session='.length) || '';
    return /^[a-f0-9]{64}$/.test(cookie) && timingSafeEqual(Buffer.from(cookie),Buffer.from(session));
  }
  async function bodyOf(req) {
    const chunks=[]; let count=0;
    for await(const chunk of req) { count+=chunk.length; if(count>160000) throw new InputError('輸入超過 160KB 限制。'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('JSON 資料格式不正確。'); }
  }
  const server = createServer(async (req,res) => {
    const address=server.address();
    const host=`127.0.0.1:${address?.port}`;
    const origin=`http://${host}`;
    const send=(value,status=200,extra={})=> { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',...extra});res.end(JSON.stringify(value)); };
    let cleanupRequest=()=>{};
    const aiRequestConfig=()=>{
      const controller=new AbortController();
      const aborted=()=>controller.abort();
      const closed=()=>{if(!res.writableEnded)controller.abort();};
      const listen=(target,event,callback)=>{if(target.once)target.once(event,callback);else target.on?.(event,callback);};
      listen(req,'aborted',aborted);listen(res,'close',closed);
      if(req.aborted)controller.abort();
      cleanupRequest=()=>{req.removeListener?.('aborted',aborted);res.removeListener?.('close',closed);};
      return Object.freeze({...config,signal:controller.signal});
    };
    try {
      if (req.headers.host!==host) return send({error:'請使用啟動時顯示的本機網址。'},403);
      const url=new URL(req.url,origin);
      const authToken=cookieValue(req.headers.cookie,'actiondesk_auth');
      const user=accounts.lookup(authToken);
      const asset = publicAssets.get(url.pathname);
      if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
        const bytes = readFileSync(path.join(root, asset[0]));
        res.writeHead(200, {'Content-Type':asset[1], 'Content-Length':bytes.length,
          'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer'});
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      if(req.method==='GET'&&url.pathname==='/showcase'){res.writeHead(302,{'Location':'/showcase/'});return res.end();}
      if(req.method==='GET'&&url.pathname==='/showcase/'){const html=readFileSync(path.join(root,'docs','index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'"});return res.end(html);}
      if (req.method==='GET' && ['/', '/index.html', '/tasks', '/speakers', '/settings', '/account', '/login', '/welcome'].includes(url.pathname)) {
        if(requireAccountAuth && !user && !['/login','/welcome'].includes(url.pathname)){
          res.writeHead(302,{'Location':url.pathname==='/'?'/welcome':'/login?next='+encodeURIComponent(url.pathname),'Cache-Control':'no-store','Set-Cookie':csrfCookie});return res.end();
        }
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'Set-Cookie':csrfCookie});
        let html=readFileSync(path.join(root,'standalone',url.pathname==='/login'?'login.html':url.pathname==='/welcome'?'welcome.html':url.pathname==='/account'?'account.html':url.pathname==='/tasks'?'index.html':url.pathname==='/speakers'?'attribution.html':url.pathname==='/settings'?'settings.html':'recall.html'),'utf8');
        if(simulation){
          const banner='<aside role="note" style="flex-shrink:0;padding:9px 16px;background:#fff0cc;color:#513c09;font:12px/1.6 system-ui;text-align:center">模擬連線環境 · AI 回答與 Notion 均為本機合成資料，不會連接真實帳號。</aside>';
          html=html.includes('<div class="app-shell">')?html.replace('<div class="app-shell">','<div class="app-shell">'+banner):html.replace('<body>','<body>'+banner);
        }
        return res.end(html);
      }
      if (url.pathname==='/favicon.svg' && req.method==='GET') {
        res.writeHead(200,{'Content-Type':'image/svg+xml','X-Content-Type-Options':'nosniff'});
        return res.end(readFileSync(path.join(root,'public','favicon.svg')));
      }
      if (!url.pathname.startsWith('/api/')) return send({error:'找不到此頁面。'},404);
      if(req.method==='GET' && url.pathname==='/api/session')return send({authenticated:!!user,user},200,{'Set-Cookie':csrfCookie});
      if (!authorized(req)) return send({error:'請重新開啟首頁取得本機工作階段。'},401);
      if (req.method==='POST') {
        if (req.headers.origin!==origin || req.headers['sec-fetch-site']==='cross-site') return send({error:'僅接受本站提交。'},403);
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json') return send({error:'請使用 JSON 格式。'},415);
      }
      const expectedAccount=req.headers['x-account-id'];
      if(expectedAccount&&!['/api/auth/login','/api/auth/register'].includes(url.pathname)&&expectedAccount!==user?.id)return send({error:'登入帳號已變更，請重新開啟工作台。',code:'account_changed'},409);
      if(req.method==='POST' && ['/api/auth/register','/api/auth/login'].includes(url.pathname)){
        authAttempts=authAttempts.filter(time=>Date.now()-time<600000);
        if(authAttempts.length>=20)return send({error:'登入嘗試過於頻繁，請稍後再試。'},429,{'Retry-After':'600'});
        authAttempts.push(Date.now());
        const body=await bodyOf(req);
        const result=url.pathname==='/api/auth/register'?accounts.register(body):accounts.login(body);
        accounts.logout(authToken);
        return send({user:result.user},url.pathname==='/api/auth/register'?201:200,{'Set-Cookie':authCookie(result.token)});
      }
      if(req.method==='POST' && url.pathname==='/api/auth/logout'){
        accounts.logout(authToken);return send({ok:true},200,{'Set-Cookie':authCookie('')});
      }
      if(req.method==='GET' && url.pathname==='/api/auth/me')return user?send({user}):send({error:'請先登入。'},401);
      if(requireAccountAuth && !user)return send({error:'請先登入以使用工作區。'},401);
      const userId=user?.id||'local-owner';
      if(req.method==='POST' && url.pathname==='/api/auth/profile'){
        if(!user)return send({error:'請先登入。'},401);
        return send({user:accounts.profile(user,await bodyOf(req))});
      }
      if (req.method==='GET' && url.pathname==='/api/status') return send({aiConfigured:!!(config.provider==='deepseek'?config.deepseekKey:config.openaiKey),provider:config.provider||'openai',providerLabel:config.provider==='deepseek'?'DeepSeek':'OpenAI',notionConfigured:!!(config.notionToken&&config.dataSourceId),storageReady:true,model:config.model,targetName:null,simulation});
      if (req.method==='POST' && url.pathname==='/api/settings/ai') {
        if(requireAccountAuth && user?.role!=='admin')return send({error:'僅管理員可修改共用 AI 設定。'},403);
        const body=await bodyOf(req);
        if(simulation)throw new InputError('示範環境不儲存金鑰，請使用正式本機服務。');
        if (!body || body.approved!==true) throw new InputError('請先同意在此電腦儲存 AI 金鑰。');
        const provider=body.provider??'openai';
        if(!['openai','deepseek'].includes(provider))throw new InputError('僅支援 DeepSeek 或 OpenAI。');
        if(typeof body.apiKey!=='string'||!/^sk-[A-Za-z0-9_-]{17,253}$/.test(body.apiKey))throw new InputError('請填入有效的 AI API 金鑰，勿包含空白或換行。');
        if(typeof body.model!=='string'||!/[a-zA-Z0-9]/.test(body.model)||!/^[A-Za-z0-9._:-]{1,80}$/.test(body.model))throw new InputError('模型名稱格式不正確。');
        const varsPath=configPath;
        const old=existsSync(varsPath)?readFileSync(varsPath,'utf8'):'';
        const prefix=provider==='deepseek'?'DEEPSEEK':'OPENAI';
        const lines=old.split(/\r?\n/).filter(line=>!new RegExp('^\\s*(?:AI_PROVIDER|'+prefix+'_(?:API_KEY|MODEL))\\s*=').test(line));
        const next=lines.join('\n').trimEnd()+'\nAI_PROVIDER='+provider+'\n'+prefix+'_API_KEY='+body.apiKey+'\n'+prefix+'_MODEL='+body.model+'\n';
        const temp=varsPath+'.tmp';
        writeFileSync(temp,next,{mode:0o600});chmodSync(temp,0o600);renameSync(temp,varsPath);chmodSync(varsPath,0o600);
        config.provider=provider;
        if(provider==='deepseek')config.deepseekKey=body.apiKey;else config.openaiKey=body.apiKey;config.model=body.model;
        return send({ok:true,aiConfigured:true,provider,providerLabel:provider==='deepseek'?'DeepSeek':'OpenAI',model:config.model});
      }
      if (req.method==='GET' && url.pathname==='/api/notion') {
        const schema=await getNotionSchema(config,fetcher);
        return send({ok:true,targetName:schema.targetName,properties:Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,{type:v.type}]))});
      }
      if (req.method==='POST' && url.pathname==='/api/attribution/demo') {
        const body=await bodyOf(req);
        if(!body || typeof body!=='object' || Array.isArray(body))throw new InputError('請提供認領會議。');
        const attribution=await buildAttribution(body.meeting,body.participants,body.events,'demo');
        return send({...attribution,managerBoard:await buildManagerBoard(validateMeeting(body.meeting),attribution)});
      }
      if (req.method==='POST' && url.pathname==='/api/attribution/notion') {
        const body=await bodyOf(req);
        if(!body || typeof body!=='object' || Array.isArray(body))throw new InputError('請提供認領會議。');
        const attribution=await previewNotionAttribution(body.meeting,config,fetcher);
        return send({...attribution,managerBoard:await buildManagerBoard(validateMeeting(body.meeting),attribution)});
      }
      if (req.method==='POST' && url.pathname==='/api/recall') {
        return send(await recallMeeting(await bodyOf(req)));
      }
      if (req.method==='POST' && url.pathname==='/api/team-summary') {
        const requestConfig=aiRequestConfig();
        const body=await bodyOf(req);
        assertAiConsent(body,requestConfig);
        if (!body || body.approved!==true) throw new InputError('請先同意將逐字稿傳送至目前設定的 AI 供應商整理。');
        validateMeeting(body.meeting);
        if(summaryInFlight)return send({error:'目前正在整理會議，請等待完成。'},429,{'Retry-After':'15'});
        recent=recent.filter(t=>Date.now()-t<60000);
        if(recent.length>=5)return send({error:'每分鐘最多使用 AI 5 次，請稍後再試。'},429,{'Retry-After':'60'});
        recent.push(Date.now()); summaryInFlight=true;
        try { return send(await summarizeTeam(body,requestConfig,fetcher)); }
        finally { summaryInFlight=false; }
      }
      if (req.method==='POST' && url.pathname==='/api/ask') {
        const requestConfig=aiRequestConfig();
        const body=await bodyOf(req);
        assertAiConsent(body,requestConfig);
        recent=recent.filter(t=>Date.now()-t<60000);
        if(recent.length>=5)return send({error:'每分鐘最多使用 AI 5 次，請稍後再試。'},429,{'Retry-After':'60'});
        recent.push(Date.now());
        return send(await askMeeting(body,requestConfig,fetcher));
      }
      if (req.method==='POST' && url.pathname==='/api/verify') {
        const body=await bodyOf(req);
        if(!body || body.approved!==true)throw new InputError('請先審閱並確認查核。');
        const meeting=validateMeeting(body.meeting),id=await meetingKey(meeting);
        if(body.meetingId!==id)throw new InputError('會議已修改，請重新整理。');
        const tasks=await validateTasks(body.tasks,meeting,id);
        if(!tasks.length)throw new InputError('請至少選擇一個任務。');
        const schema=await getNotionSchema(config,fetcher);
        const result=await verifyTasks(userId,meeting,tasks,config,schema,fetcher);
        return send(result,200,result.retryAfter?{'Retry-After':result.retryAfter}:{});
      }
      if (req.method==='POST' && url.pathname==='/api/validate-tasks') {
        const body=await bodyOf(req);
        if(!body || typeof body!=='object' || Array.isArray(body))throw new InputError('請提供會議與已審閱任務。');
        const meeting=validateMeeting(body.meeting),id=await meetingKey(meeting);
        if(body.meetingId!==id)throw new InputError('會議已修改，請重新整理。');
        const tasks=await validateTasks(body.tasks,meeting,id,false);
        return send({meetingId:id,tasks,mode:meeting.mode,summary:'已載入團隊總覽審閱的任務，請確認後寫入 Notion。'});
      }
      if (req.method==='POST' && url.pathname==='/api/extract') {
        const requestConfig=aiRequestConfig();
        const body=await bodyOf(req);
        const meeting=validateMeeting(body);
        if(meeting.mode==='ai') {
          assertAiConsent(body,requestConfig);
          recent=recent.filter(t=>Date.now()-t<60000);
          if(recent.length>=5) return send({error:'每分鐘最多整理 5 次 AI 內容，請稍後再試。'},429,{'Retry-After':'60'});
          recent.push(Date.now());
        }
        return send(meeting.mode==='rules'?await extractRules(meeting):await extractAI(meeting,requestConfig,fetcher));
      }
      if (req.method==='POST' && url.pathname==='/api/sync') {
        const body=await bodyOf(req);
        if(!body || body.approved!==true)throw new InputError('請先審閱並確認寫入。');
        const meeting=validateMeeting(body.meeting),id=await meetingKey(meeting);
        if(body.meetingId!==id)throw new InputError('會議已修改，請重新整理。');
        const tasks=await validateTasks(body.tasks,meeting,id);
        if(!tasks.length)throw new InputError('請至少選擇一個任務。');
        const schema=await getNotionSchema(config,fetcher);
        const result=await syncTasks(userId,meeting,tasks,config,schema,receipts,fetcher,body.reconcileOnly===true);
        return send(result,200,result.retryAfter?{'Retry-After':result.retryAfter}:{});
      }
      return send({error:'找不到此操作。'},404);
    } catch(error) {
      if(res.headersSent){res.end();return;}
      if(error instanceof InputError)return send({error:error.message},400);
      if(error instanceof ProviderError)return send({error:error.message,uncertain:error.uncertain},error.status,error.retryAfter?{'Retry-After':error.retryAfter}:{});
      send({error:'服務暫時無法完成此操作。'},500);
    } finally { cleanupRequest(); }
  });
  server.on('close',()=>db.close());
  return server;
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const port=Number(process.env.ACTIONDESK_PORT||4173);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('ACTIONDESK_PORT 必須介於 1024 與 65535');
  const server=createApplication({requireAccountAuth:true});
  server.listen(port,'127.0.0.1',()=>console.log(`記補住 ready: http://127.0.0.1:${port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
