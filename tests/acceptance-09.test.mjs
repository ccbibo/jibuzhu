// Legacy API/provider coverage: account-auth gates are tested separately with the production default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHttpFixture } from './auth-http-fixture.mjs';
import { startSimulation } from '../scripts/simulation-server.mjs';
import { createApplication } from '../standalone/server.mjs';

const meeting = { title: 'tester09 審閱整合', meetingDate: '2026-10-31', mode: 'rules', transcript: '小美：我會明天提交報表。\n主任：仍需審查，沒有共同決議。' };
async function client(appUrl) {
  const cookie = await registerHttpFixture(appUrl);
  const home = await fetch(appUrl,{headers:{Cookie:cookie}});
  assert.equal(home.status, 200);
  assert.match(home.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  return {
    post: (route, body, headers = {}) => fetch(appUrl + route, { method: 'POST', headers: { Cookie: cookie, Origin: appUrl, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    get: route => fetch(appUrl + route, { headers: { Cookie: cookie } }),
  };
}
async function json(response, expected = 200) { assert.equal(response.status, expected, await response.clone().text()); return response.json(); }

test('tester09 real HTTP: edit source → reextract → edit task → sync → paginated readback → repeat', async t => {
  const sim = await startSimulation({ appPort: 0, notionPort: 0 }); t.after(() => sim.close());
  const c = await client(sim.appUrl);
  const original = await json(await c.post('/api/extract', meeting));
  const editedMeeting = { ...meeting, transcript: meeting.transcript.replace('明天提交報表', '在 2026-11-04 前提交修正版報表') };
  const stale = { meeting: editedMeeting, meetingId: original.meetingId, tasks: original.tasks, approved: true };
  await json(await c.post('/api/sync', stale), 400); await json(await c.post('/api/verify', stale), 400);
  assert.equal(sim.state.creates, 0);
  const extraction = await json(await c.post('/api/extract', editedMeeting));
  assert.equal(extraction.tasks.length, 1); assert.notEqual(extraction.meetingId, original.meetingId);
  const task = { ...extraction.tasks[0], title: '審閱後：提交修正版報表', assignee: '小美', dueDate: '2026-11-05', priority: 'high' };
  const body = { meeting: editedMeeting, meetingId: extraction.meetingId, tasks: [task], approved: true };
  assert.equal((await json(await c.post('/api/verify', body))).results[0].status, 'missing');
  assert.equal(sim.state.creates, 0);
  assert.equal((await json(await c.post('/api/sync', body))).results[0].status, 'created');
  const created = [...sim.state.pages.values()][0];
  assert.equal(created.properties.任務.title[0].text.content, task.title);
  assert.equal(created.properties.截止日期.date.start, '2026-11-05');
  assert.equal((await json(await c.post('/api/verify', body))).results[0].status, 'verified');
  assert.ok(sim.state.requests.filter(r => r.path.endsWith('/children')).length >= 2);
  assert.equal((await json(await c.post('/api/sync', body))).results[0].status, 'existing');
  assert.equal(sim.state.creates, 1);
  // A success receipt is not a readback: the current reviewed title must still match remotely.
  const changed = { ...body, tasks: [{ ...task, title: '第二次改名但未寫入' }] };
  assert.equal((await json(await c.post('/api/sync', changed))).results[0].status, 'existing');
  const mismatch = await json(await c.post('/api/verify', changed));
  assert.equal(mismatch.results[0].status, 'mismatch'); assert.match(mismatch.results[0].differences.join(), /任務/);
  assert.equal(sim.state.creates, 1);
  const board = await (await fetch(sim.notionUrl)).text();
  assert.match(board, /不是實際 Notion/); assert.ok(board.includes(task.title));
});

test('tester09 real HTTP simulation QA discloses fixed fixture and rejects unsupported semantics', async t => {
  const sim = await startSimulation({ appPort: 0, notionPort: 0 }); t.after(() => sim.close());
  const c = await client(sim.appUrl);
  assert.equal((await json(await c.get('/api/status'))).simulation, true);
  assert.match(await (await c.get('/')).text(), /AI 回答與 Notion 均為本機合成資料/);
  const transcript = readFileSync(new URL('../standalone/recall.html', import.meta.url), 'utf8').match(/const sample=`([\s\S]*?)`;/)[1];
  const m = { ...meeting, mode: 'ai', transcript };
  const result = await json(await c.post('/api/ask', { meeting: m, question: '品妤對快取失效有哪些顧慮？最後是否形成決議？', speaker: '品妤' }));
  assert.equal(result.claims.length, 3); assert.equal(result.claims[2].citations[0].lineIndex, 8);
  assert.ok(result.claims.every(claim => claim.citations.every(citation => citation.speaker === '品妤' && transcript.split('\n')[citation.lineIndex].includes(citation.quote))));
  assert.match(result.caveats.join(), /非真實 AI/); assert.match(result.notice, /不等於語意蘊含驗證/);
  const unsupported = await json(await c.post('/api/ask', { meeting: m, question: '誰負責預算？', speaker: '' }), 502);
  assert.ok(unsupported.error); assert.equal(unsupported.claims, undefined);
  assert.equal(sim.state.creates, 0);
});

test('tester09 real HTTP model boundary: explicit ask transmits full source; unauthorized/error never become answers', async t => {
  const calls = [];
  const app = createApplication({requireAccountAuth:false, databasePath: ':memory:', config: { model: 'tester09-fixture', openaiKey: 'tester09-only-fake' }, fetcher: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response('private-upstream-text tester09-only-fake', { status: 500 });
  } });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  const c = await client(appUrl);
  await c.get('/api/status'); assert.equal(calls.length, 0);
  const transcript = '甲：開場\n' + Array.from({ length: 120 }, (_, i) => `乙：第${i}個不相關說明`).join('\n') + '\n丙：尾端保留不同意。';
  const body = { meeting: { ...meeting, mode: 'ai', transcript }, question: ' 有無決議？ ', speaker: '' };
  assert.equal((await fetch(appUrl + '/api/ask', { method: 'POST', headers: { Origin: appUrl, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
  assert.equal((await c.post('/api/ask', body, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal(calls.length, 0);
  const result = await json(await c.post('/api/ask', body), 502);
  assert.equal(calls.length, 1);
  const payload = calls[0].body; const input = JSON.parse(payload.input);
  assert.equal(input.lines.map(line => line.text).join('\n'), transcript);
  assert.equal(input.lines.at(-1).speaker, '丙'); assert.equal(input.question, '有無決議？');
  assert.equal(payload.store, false); assert.equal(payload.text.format.strict, true);
  assert.equal(result.claims, undefined); assert.ok(!JSON.stringify(result).includes('private-upstream'));
  assert.ok(!JSON.stringify(result).includes('tester09-only-fake'));
});

test('tester09 counterexample exchange: HTTP socket loss after remote create reconciles without duplication', async t => {
  const sim = await startSimulation({ appPort: 0, notionPort: 0 }); t.after(() => sim.close());
  const c = await client(sim.appUrl);
  const extracted = await json(await c.post('/api/extract', meeting));
  const body = { meeting, meetingId: extracted.meetingId, tasks: extracted.tasks, approved: true };
  sim.state.dropNextCreateResponse = true;
  const first = await json(await c.post('/api/sync', body));
  assert.equal(first.results[0].status, 'uncertain');
  assert.equal(sim.state.creates, 1); assert.equal(sim.state.pages.size, 1);
  const recovered = await json(await c.post('/api/sync', { ...body, reconcileOnly: true }));
  assert.equal(recovered.results[0].status, 'existing'); assert.equal(sim.state.creates, 1);
  assert.equal((await json(await c.post('/api/verify', body))).results[0].status, 'verified');
  const page = [...sim.state.pages.values()][0];
  sim.state.pages.set('duplicate', { ...structuredClone(page), id: 'duplicate' });
  const duplicate = await json(await c.post('/api/verify', body));
  assert.equal(duplicate.results[0].status, 'mismatch'); assert.match(duplicate.results[0].differences.join(), /重複/);
  assert.equal(sim.state.creates, 1);
});
