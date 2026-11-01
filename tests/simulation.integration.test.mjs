import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHttpFixture } from './auth-http-fixture.mjs';
import { startSimulation } from '../scripts/simulation-server.mjs';

const meeting = { title: '模擬部署驗收', meetingDate: '2026-10-31', transcript: '小林：我會在 2026-11-03 前整理試聽學生名單。\n小陳：我會明天提交家長說明會簡報。', mode: 'ai' };
async function fixture(t) {
  const sim = await startSimulation({ appPort: 0, notionPort: 0 });
  t.after(() => sim.close());
  const cookie = await registerHttpFixture(sim.appUrl);
  const home = await fetch(sim.appUrl + '/tasks',{headers:{Cookie:cookie}});
  assert.equal(home.status, 200);
  const post = async (route, body, headers = {}) => {
    const response = await fetch(sim.appUrl + route, { method: 'POST', headers: { Cookie: cookie, Origin: sim.appUrl, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { ...sim, cookie, post };
}
test('real HTTP: AI-shaped extraction → manual review → SQLite sync → complete paginated readback → repeat without duplicates', async t => {
  const f = await fixture(t);
  const result = await f.post('/api/extract', meeting);
  assert.equal(result.status, 200); assert.equal(result.data.mode, 'ai'); assert.equal(result.data.tasks.length, 2);
  const tasks = result.data.tasks.map((task, i) => ({ ...task, title: i ? '人工確認：提交家長簡報' : '人工確認：整理名單 <script>alert(1)</script>', assignee: i ? '人工確認陳老師' : '人工確認林老師', dueDate: i ? '2026-11-05' : '2026-11-04', priority: i ? 'low' : 'high', warnings: ['已人工確認負責人及日期'] }));
  const body = { approved: true, meeting, meetingId: result.data.meetingId, tasks };
  assert.equal((await f.post('/api/sync', { ...body, approved: false })).status, 400);
  assert.equal((await f.post('/api/sync', body, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal(f.state.creates, 0);
  const first = await f.post('/api/sync', body);
  assert.equal(first.status, 200); assert.deepEqual(first.data.results.map(r => r.status), ['created', 'created']);
  assert.equal(f.state.pages.size, 2);
  const pages = [...f.state.pages.values()];
  for (const [i, page] of pages.entries()) {
    assert.equal(page.parent.data_source_id, 'simulation-tasks');
    assert.equal(page.properties.任務.title[0].text.content, tasks[i].title);
    assert.equal(page.properties.負責人.rich_text[0].text.content, tasks[i].assignee);
    assert.deepEqual(page.properties.截止日期.date, { start: tasks[i].dueDate, end: null, time_zone: null });
    assert.equal(page.properties.優先級.select.name, i ? '低' : '高');
    assert.match(page.properties['來源 ID'].rich_text[0].text.content, /^actiondesk:[0-9a-f]{64}$/);
    assert.equal(page.children.length, 4);
    assert.ok(page.children[1].paragraph.rich_text[0].text.content.includes(tasks[i].evidence));
    assert.ok(page.children[3].paragraph.rich_text[0].text.content.includes('已人工確認負責人及日期'));
  }
  const checked = await f.post('/api/verify', body);
  assert.deepEqual(checked.data.results.map(r => r.status), ['verified', 'verified']);
  assert.equal(f.state.requests.filter(r => r.path.endsWith('/children')).length, 4);
  const repeated = await f.post('/api/sync', body);
  assert.deepEqual(repeated.data.results.map(r => r.status), ['existing', 'existing']); assert.equal(f.state.creates, 2);
  const board = await (await fetch(f.notionUrl)).text();
  assert.match(board, /不是實際 Notion/); assert.match(board, /目前 2 個模擬頁面/);
  assert.ok(board.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(!board.includes('<script>alert(1)</script>'));
  assert.equal((await fetch(f.notionUrl + '/admin', { method: 'POST', body: '{}' })).status, 404);
});
test('real HTTP: independent readback detects remote corruption and verifies again only after restoration', async t => {
  const f = await fixture(t);
  const extracted = (await f.post('/api/extract', meeting)).data;
  const body = { approved: true, meeting, meetingId: extracted.meetingId, tasks: extracted.tasks };
  await f.post('/api/sync', body);
  const page = [...f.state.pages.values()][0], saved = structuredClone(page);
  page.properties.負責人.rich_text[0].text.content = '遠端已被改寫';
  page.children[1].paragraph.rich_text[0].text.content = '遠端原文被改寫';
  const mismatch = (await f.post('/api/verify', body)).data.results;
  assert.equal(mismatch[0].status, 'mismatch'); assert.ok(mismatch[0].differences.some(d => d.includes('負責人'))); assert.ok(mismatch[0].differences.some(d => d.includes('原文依據'))); assert.equal(mismatch[1].status, 'verified');
  f.state.pages.set(saved.id, saved);
  assert.ok((await f.post('/api/verify', body)).data.results.every(r => r.status === 'verified'));
  assert.equal(f.state.creates, 2);
});
test('real HTTP: committed create with lost response stays uncertain, reconciliation finds it without a second create', async t => {
  const f = await fixture(t);
  const extracted = (await f.post('/api/extract', meeting)).data;
  const body = { approved: true, meeting, meetingId: extracted.meetingId, tasks: [extracted.tasks[0]] };
  f.state.dropNextCreateResponse = true;
  assert.equal((await f.post('/api/sync', body)).data.results[0].status, 'uncertain');
  assert.equal(f.state.creates, 1); assert.equal(f.state.pages.size, 1);
  assert.equal((await f.post('/api/sync', { ...body, reconcileOnly: true })).data.results[0].status, 'existing');
  assert.equal((await f.post('/api/sync', body)).data.results[0].status, 'existing');
  assert.equal(f.state.creates, 1);
  assert.equal((await f.post('/api/verify', body)).data.results[0].status, 'verified');
});
test('real HTTP: default ten-person QA has source-checked fixtures and unknown questions never pretend semantic answers', async t => {
  const f = await fixture(t);
  const html = readFileSync(new URL('../standalone/recall.html', import.meta.url), 'utf8');
  const sample = html.match(/const sample=`([\s\S]*?)`;/)?.[1];
  assert.ok(sample, 'default ten-person transcript fixture exists');
  const body = { meeting: { ...meeting, transcript: sample }, question: '品妤對快取失效有哪些顧慮？最後是否形成決議？', speaker: '品妤' };
  const answer = await f.post('/api/ask', body);
  assert.equal(answer.status, 200); assert.equal(answer.data.claims.length, 3);
  for (const claim of answer.data.claims) for (const cite of claim.citations) { assert.equal(cite.speaker, '品妤'); assert.ok(sample.split('\n')[cite.lineIndex].includes(cite.quote)); }
  assert.ok(answer.data.caveats.some(c => c.includes('非真實 AI')));
  assert.equal((await f.post('/api/ask', { ...body, question: '請推測下次決議' })).status, 502);
  assert.equal(f.state.creates, 0);
});
test('simulation fetch routing blocks other destinations and no session can invoke app APIs', async t => {
  const f = await fixture(t);
  for (const url of ['https://example.com/v1/pages', 'https://api.notion.com.evil.example/v1/pages', 'http://api.notion.com/v1/pages', 'https://api.openai.com:444/v1/responses']) await assert.rejects(() => f.fetcher(url));
  assert.equal((await fetch(f.appUrl + '/api/status')).status, 401);
  const status = await (await fetch(f.appUrl + '/api/status', { headers: { Cookie: f.cookie } })).json();
  assert.ok(!JSON.stringify(status).includes('simulation-only-no-real'));
});
