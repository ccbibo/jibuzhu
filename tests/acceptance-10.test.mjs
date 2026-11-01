import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHttpFixture } from './auth-http-fixture.mjs';
import { startSimulation } from '../scripts/simulation-server.mjs';

const meeting = { title: 'tester10 release adversary', meetingDate: '2026-10-31', mode: 'rules', transcript: '小美：我會明天提交報表。\n主任：沒有共同決議。' };
async function setup(t) {
  const sim = await startSimulation({ appPort: 0, notionPort: 0 });
  t.after(() => sim.close());
  const cookie = await registerHttpFixture(sim.appUrl);
  const home = await fetch(sim.appUrl,{headers:{Cookie:cookie}});
  const html = await home.text();
  const post = (route, body, headers = {}) => fetch(sim.appUrl + route, { method: 'POST', headers: { Cookie: cookie, Origin: sim.appUrl, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { sim, html, cookie, post };
}
async function json(res, status = 200) { assert.equal(res.status, status, await res.clone().text()); return res.json(); }

test('tester10 real HTTP: simulation is visible before submission and QA is quotes-only fixture', async t => {
  const { sim, html, cookie, post } = await setup(t);
  assert.match(html, /模擬連線環境.*本機合成資料/);
  const status = await json(await fetch(sim.appUrl + '/api/status', { headers: { Cookie: cookie } }));
  assert.equal(status.simulation, true);
  assert.equal(status.model, 'simulation-deterministic-rules');
  assert.equal(sim.state.requests.length, 0);
  const transcript = html.match(/const sample=`([\s\S]*?)`;/)[1];
  const qa = await json(await post('/api/ask', { meeting: { ...meeting, mode: 'ai', transcript }, question: '品妤對快取失效有哪些顧慮？最後是否形成決議？', speaker: '品妤' }));
  assert.equal(qa.claims.length, 3);
  for (const claim of qa.claims) {
    assert.equal(claim.requiresReview, true);
    assert.equal(claim.verification, 'quotes_only');
    for (const c of claim.citations) { assert.equal(c.speaker, '品妤'); assert.ok(transcript.split('\n')[c.lineIndex].includes(c.quote)); }
  }
  assert.match(qa.caveats.join(), /非真實 AI/);
  assert.match(qa.notice, /不等於語意蘊含驗證/);
  const unsupported = await json(await post('/api/ask', { meeting: { ...meeting, mode: 'ai', transcript }, question: '任何其他問題都能回答嗎？', speaker: '' }), 502);
  assert.ok(unsupported.error); assert.equal(unsupported.claims, undefined);
  const board = await (await fetch(sim.notionUrl)).text();
  assert.match(board, /模擬環境・不是實際 Notion・僅供讀取/);
});

test('tester10 real HTTP: every unauthorized product API is fetch-free', async t => {
  const { sim, cookie, post } = await setup(t);
  for (const route of ['/api/status', '/api/notion', '/api/recall', '/api/ask', '/api/extract', '/api/sync', '/api/verify']) {
    const method = ['/api/status', '/api/notion'].includes(route) ? 'GET' : 'POST';
    const res = await fetch(sim.appUrl + route, { method, headers: { Origin: sim.appUrl, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(meeting) } : {}) });
    assert.equal(res.status, 401, route);
  }
  for (const route of ['/api/recall', '/api/ask', '/api/extract', '/api/sync', '/api/verify']) assert.equal((await post(route, meeting, { Origin: 'https://attacker.example' })).status, 403, route);
  assert.equal(sim.state.requests.length, 0);
  assert.equal(sim.state.creates, 0);
  const status = await json(await fetch(sim.appUrl + '/api/status', { headers: { Cookie: cookie } }));
  assert.ok(!JSON.stringify(status).includes('simulation-only-no-real-key'));
});

test('tester10 provider destination denylist and old source IDs fail before provider fetch', async t => {
  const { sim, post } = await setup(t);
  for (const url of ['http://api.notion.com/v1/pages', 'https://api.notion.com.evil.example/v1/pages', 'https://api.notion.com@evil.example/v1/pages', 'https://api.openai.com:444/v1/responses', 'https://user:pass@api.openai.com/v1/responses', 'https://127.0.0.1/v1/pages']) {
    await assert.rejects(() => sim.fetcher(url), /blocks all non-provider/);
  }
  assert.equal(sim.state.requests.length, 0);
  const extracted = await json(await post('/api/extract', meeting));
  assert.equal(extracted.tasks.length, 1);
  const edited = { ...meeting, transcript: meeting.transcript + '\n小美：更正，報表尚需審閱。' };
  const stale = { meeting: edited, meetingId: extracted.meetingId, tasks: extracted.tasks, approved: true };
  const before = sim.state.requests.length;
  for (const route of ['/api/sync', '/api/verify']) assert.match((await json(await post(route, stale), 400)).error, /會議已修改/);
  assert.equal(sim.state.requests.length, before);
  assert.equal(sim.state.creates, 0);
});

test('tester10 full candidate HTTP path: reextract, approve, write, readback, detect remote drift', async t => {
  const { sim, post } = await setup(t);
  const edited = { ...meeting, transcript: '小美：我會在 2026-11-04 前提交修正版報表。\n主任：仍需審閱，未形成決議。' };
  const extracted = await json(await post('/api/extract', edited));
  const task = { ...extracted.tasks[0], title: '人工確認：提交修正版報表', dueDate: '2026-11-05', priority: 'high' };
  const body = { meeting: edited, meetingId: extracted.meetingId, tasks: [task], approved: true };
  assert.equal((await json(await post('/api/verify', body))).results[0].status, 'missing');
  assert.equal(sim.state.creates, 0);
  assert.equal((await json(await post('/api/sync', body))).results[0].status, 'created');
  assert.equal((await json(await post('/api/verify', body))).results[0].status, 'verified');
  assert.ok(sim.state.requests.filter(r => r.path.endsWith('/children')).length >= 2);
  assert.equal((await json(await post('/api/sync', body))).results[0].status, 'existing');
  assert.equal(sim.state.creates, 1);
  const page = [...sim.state.pages.values()][0];
  page.properties.負責人.rich_text = [{ type: 'text', text: { content: '錯人物' } }];
  const drift = (await json(await post('/api/verify', body))).results[0];
  assert.equal(drift.status, 'mismatch'); assert.match(drift.differences.join(), /負責人/);
  assert.equal(sim.state.creates, 1);
});

test('tester10 tester09 counterexample: lost create response and duplicate source never become false verified', async t => {
  const { sim, post } = await setup(t);
  const extracted = await json(await post('/api/extract', meeting));
  const body = { meeting, meetingId: extracted.meetingId, tasks: extracted.tasks, approved: true };
  sim.state.dropNextCreateResponse = true;
  assert.equal((await json(await post('/api/sync', body))).results[0].status, 'uncertain');
  assert.equal(sim.state.creates, 1);
  assert.equal((await json(await post('/api/sync', { ...body, reconcileOnly: true }))).results[0].status, 'existing');
  assert.equal(sim.state.creates, 1);
  assert.equal((await json(await post('/api/verify', body))).results[0].status, 'verified');
  const original = [...sim.state.pages.values()][0];
  sim.state.pages.set('tester10-duplicate', { ...structuredClone(original), id: 'tester10-duplicate' });
  const duplicate = (await json(await post('/api/verify', body))).results[0];
  assert.equal(duplicate.status, 'mismatch');
  assert.match(duplicate.differences.join(), /重複/);
  assert.equal(sim.state.creates, 1);
});

test('tester10 static UI: keyboard/mobile provisions and review caveats are explicit (not browser QA)', () => {
  const html = readFileSync(new URL('../standalone/recall.html', import.meta.url), 'utf8');
  assert.match(html, /name="viewport"/);
  assert.match(html, /@media\(max-width:680px\).*grid-template-columns:1fr/);
  assert.match(html, /focus-visible/);
  assert.match(html, /ArrowLeft.*ArrowRight.*Home.*End/);
  assert.match(html, /line\.focus\(\{preventScroll:true\}\)/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /模型解讀・未驗證/);
  assert.match(html, /原文吻合不代表解讀正確/);
  assert.match(html, /simulationMode=data\.simulation===true/);
  assert.match(html, /模擬 AI 連線：只支援內建品妤快取問題，沒有真實模型或金鑰/);
  assert.match(html, /simulationMode\?'正在向本機模擬服務驗證固定案例，未呼叫外部 AI 供應商/);
  assert.match(html, /version!==revision/);
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
});
