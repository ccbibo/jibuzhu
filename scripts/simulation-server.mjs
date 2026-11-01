import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createApplication } from '../standalone/server.mjs';
import { extractRules } from '../lib/task-engine.ts';

const schema = { 任務: { type: 'title' }, '來源 ID': { type: 'rich_text' }, 負責人: { type: 'rich_text' }, 截止日期: { type: 'date' }, 優先級: { type: 'select' } };
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const textOf = rich => (rich ?? []).map(v => v.text?.content ?? '').join('');
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(`http://127.0.0.1:${server.address().port}`); });
});
const stop = server => new Promise(resolve => { if (!server?.listening) return resolve(); server.close(resolve); server.closeAllConnections(); });

/** Two real local HTTP servers; provider fetch is closed to every external destination. */
export async function startSimulation({ appPort = 4174, notionPort = 4175 } = {}) {
  const state = { pages: new Map(), requests: [], creates: 0, dropNextCreateResponse: false };
  const simulator = createServer(async (req, res) => {
    const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      state.requests.push({ method: req.method, path: url.pathname });
      if (req.method === 'GET' && url.pathname === '/') {
        const cards = [...state.pages.values()].map(page => `<article><h2>${escapeHTML(textOf(page.properties.任務.title))}</h2><pre>${escapeHTML(JSON.stringify(page.properties, null, 2))}</pre>${page.children.map(b => `<p>${escapeHTML(textOf(b.paragraph.rich_text))}</p>`).join('')}</article>`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        res.end(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Notion 本機模擬看板</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:20px;background:#f6f5ef;color:#24392e}article{background:white;padding:24px;margin:20px 0;border:1px solid #ccd4c7;border-radius:12px}pre,p{white-space:pre-wrap;overflow-wrap:anywhere}strong{color:#8c4d00}</style><h1>Notion 本機模擬看板</h1><strong>模擬環境・不是實際 Notion・僅供讀取</strong><p>所有頁面僅保存在本程序記憶體；重新整理可讀取目前狀態，重啟即清除。</p><p>目前 ${state.pages.size} 個模擬頁面</p>${cards || '<p>尚未建立模擬任務。</p>'}</html>`);
        return;
      }
      let body = {};
      if (req.method === 'POST') {
        const parts = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 200000) return send({ error: 'too large' }, 413); parts.push(chunk); }
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      }
      if (req.method === 'POST' && url.pathname === '/openai/v1/responses') {
        const input = JSON.parse(body.input);
        let output;
        if (body.text?.format?.name === 'meeting_tasks' && body.text.format.strict === true) {
          const extracted = await extractRules({ title: input.title, meetingDate: input.meetingDate, transcript: input.lines.map(l => l.text).join('\n'), mode: 'rules' });
          output = { summary: '本機模擬：以保守規則提供確定性資料，未呼叫真實 AI。', tasks: extracted.tasks.map(({ id, ...task }) => task) };
        } else if (body.text?.format?.name === 'meeting_answer' && body.text.format.strict === true) {
          const supportedQuestions = ['品妤對快取失效有哪些顧慮？最後是否形成決議？', '品妤對快取失效有哪些顧慮？最後有沒有形成決議？'];
          const exact = [
            ['快取失效時，應回到原始文件確認版本，不能直接用過期片段。', 'objection', '品妤指出快取失效時需回原始文件核對版本。'],
            ['另一個快取失效情境是權限撤回，必須同步移除可見片段。', 'objection', '品妤指出權限撤回時需移除可見片段。'],
            ['我還想補充，快取更新的延遲需要量測，暫時沒有定案。', 'unknown', '品妤補充需量測快取更新延遲，這段原文表示暫時沒有定案。'],
          ];
          if (!supportedQuestions.includes(input.question) || !['', '品妤'].includes(input.speaker)) return send({ error: '模擬器只支援畫面預設的品妤快取問題；不模擬任意語意推論。' }, 422);
          const citations = exact.map(([quote, kind, text]) => ({ text, kind, citations: [{ lineIndex: input.lines.findIndex(l => l.speaker === '品妤' && l.text.includes(quote)), quote }] }));
          if (citations.some(c => c.citations[0].lineIndex < 0)) return send({ error: '模擬問答需要完整十人合成案例。' }, 422);
          output = { claims: citations, caveats: ['本機確定性測試資料，非真實 AI 推論；沒有任何外部 API 呼叫。', '僅能從引用原文確認品妤表示暫時沒有定案，不能推論全體形成共識。'] };
        } else return send({ error: 'unsupported simulation schema' }, 422);
        return send({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
      }
      if (req.method === 'GET' && url.pathname === '/v1/data_sources/simulation-tasks') return send({ object: 'data_source', id: 'simulation-tasks', properties: schema, title: [{ plain_text: '本機模擬任務表（不是實際 Notion）' }] });
      if (req.method === 'POST' && url.pathname === '/v1/data_sources/simulation-tasks/query') {
        if (body.filter?.property !== '來源 ID' || typeof body.filter?.rich_text?.equals !== 'string') return send({ error: 'exact source filter required' }, 400);
        const results = [...state.pages.values()].filter(p => textOf(p.properties['來源 ID'].rich_text) === body.filter.rich_text.equals).map(({ id }) => ({ id }));
        return send({ object: 'list', results: results.slice(0, 2), has_more: results.length > 2, next_cursor: null });
      }
      if (req.method === 'POST' && url.pathname === '/v1/pages') {
        if (body.parent?.data_source_id !== 'simulation-tasks' || !body.properties || !Array.isArray(body.children)) return send({ error: 'invalid payload' }, 400);
        const id = `simulation-page-${++state.creates}`;
        const properties = Object.fromEntries(Object.entries(body.properties).map(([name, property]) => {
          const type = schema[name]?.type;
          return [name, { ...property, type, ...(type === 'date' && property.date ? { date: { ...property.date, end: null, time_zone: null } } : {}) }];
        }));
        state.pages.set(id, structuredClone({ id, parent: body.parent, properties, children: body.children.map((b, index) => ({ ...b, id: `${id}-block-${index}`, has_children: false, archived: false, in_trash: false })), archived: false, in_trash: false }));
        if (state.dropNextCreateResponse) { state.dropNextCreateResponse = false; req.socket.destroy(); return; }
        return send({ id });
      }
      const pageMatch = url.pathname.match(/^\/v1\/pages\/([^/]+)$/);
      if (req.method === 'GET' && pageMatch) { const page = state.pages.get(pageMatch[1]); if (!page) return send({ error: 'missing' }, 404); const { children, ...rest } = page; return send(rest); }
      const blockMatch = url.pathname.match(/^\/v1\/blocks\/([^/]+)\/children$/);
      if (req.method === 'GET' && blockMatch) {
        const page = state.pages.get(blockMatch[1]); if (!page) return send({ error: 'missing' }, 404);
        const start = Number(url.searchParams.get('start_cursor') || 0);
        if (!Number.isInteger(start) || start < 0) return send({ error: 'invalid cursor' }, 400);
        const end = Math.min(start + 2, page.children.length);
        return send({ object: 'list', results: page.children.slice(start, end), has_more: end < page.children.length, next_cursor: end < page.children.length ? String(end) : null });
      }
      return send({ error: 'simulation route not found' }, 404);
    } catch { if (!res.headersSent) send({ error: 'invalid simulation request' }, 400); else res.end(); }
  });
  let app;
  try {
    const notionUrl = await listen(simulator, notionPort);
    const fetcher = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !['api.notion.com', 'api.openai.com'].includes(url.hostname)) throw new Error('Simulation blocks all non-provider destinations');
      const prefix = url.hostname === 'api.openai.com' ? '/openai' : '';
      return fetch(notionUrl + prefix + url.pathname + url.search, { ...init, redirect: 'error' });
    };
    app = createApplication({ config: { model: 'simulation-deterministic-rules', openaiKey: 'simulation-only-no-real-key', notionToken: 'simulation-only-no-real-token', dataSourceId: 'simulation-tasks' }, databasePath: ':memory:', fetcher, simulation: true });
    const appUrl = await listen(app, appPort);
    return { appUrl, notionUrl, state, fetcher, close: async () => { await stop(app); await stop(simulator); } };
  } catch (error) { if (app && !app.listening) app.emit('close'); await stop(app); await stop(simulator); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const simulation = await startSimulation();
  console.log(`記補住：本機模擬部署（不是實際 Notion / OpenAI）\n應用：${simulation.appUrl}\n唯讀模擬 Notion 看板：${simulation.notionUrl}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await simulation.close(); process.exit(0); });
}
