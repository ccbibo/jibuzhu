import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttribution } from '../lib/attribution.ts';
import { buildManagerBoard } from '../lib/manager-board.ts';
const meeting={title:'主管總覽',meetingDate:'2026-10-31',mode:'rules',transcript:'A：我建議保留雨天備案。\nB：我會整理報名表，明天提供。\n這是延續內容，沒有獨立標記。\nA：請小王整理場地表。\nB：尚未完成報名表。'};
const people=[{id:'one',name:'小王'},{id:'two',name:'小王'}];
async function setup(events=[],m=meeting){const a=await buildAttribution(m,people,events);return [a,await buildManagerBoard(m,a)];}
const evt=(id,actorId,action,segmentId)=>({id,actorId,action,segmentIds:[segmentId]});
test('manager board keeps source labels provisional and continuation unresolved',async()=>{
 const [a,b]=await setup();assert.equal(b.people.length,2);assert.ok(b.people.every(p=>p.identity==='source'));assert.equal(b.unresolved[0].lineIndex,2);assert.equal(b.tasks.length,2);assert.ok(b.tasks.every(t=>t.assignee===null&&t.speakerId===null));assert.deepEqual(b.people[0].suggestions.map(s=>s.lineIndex),[0]);assert.equal(b.tasks[0].dueDate,'2026-11-01');
});
test('confirmed speakers group by exact identity without treating speaker as task owner',async()=>{
 const [a]=await setup();const events=[evt('a','one','claim',a.segments[1].id),evt('b','one','confirm',a.segments[1].id),evt('c','two','claim',a.segments[3].id),evt('d','two','confirm',a.segments[3].id)];
 const [,b]=await setup(events);const confirmed=b.people.filter(p=>p.identity==='confirmed');assert.equal(confirmed.length,2);assert.notEqual(confirmed[0].id,confirmed[1].id);assert.equal(b.tasks[0].speakerId,'one');assert.equal(b.tasks[1].speakerId,'two');assert.ok(b.tasks.every(t=>t.assignee===null));
});
test('disputed and retracted claims cannot remain in confirmed person overview',async()=>{
 const [a]=await setup();const id=a.segments[1].id;const prefix=[evt('a','one','claim',id),evt('b','one','confirm',id),evt('c','two','claim',id)];
 const [,b]=await setup(prefix);assert.ok(!b.people.some(p=>p.identity==='confirmed'));assert.ok(b.unresolved.some(s=>s.id===id));assert.equal(b.tasks[0].speakerId,null);
 const [,c]=await setup([...prefix,evt('d','two','retract',id)]);assert.ok(!c.people.some(p=>p.identity==='confirmed'));
});
test('completed, hypothetical, negated or suggestion text is not accepted as a tracked task',async()=>{
 const m={...meeting,transcript:'A：我建議整理報名表。\nA：如果我會完成就通知。\nA：我已完成初稿。\nA：我不建議更換場地。'};
 const [,b]=await setup([],m);assert.equal(b.tasks.length,0);assert.deepEqual(b.people[0].suggestions.map(s=>s.lineIndex),[0]);assert.ok(!Object.hasOwn(b,'completed'));
});
test('source revision mismatch rejects instead of recycling a stale board',async()=>{
 const [a]=await setup();await assert.rejects(()=>buildManagerBoard({...meeting,transcript:meeting.transcript+'\n新增'},a),/版本/);
});
test('overview covers all source lines beyond the thirty-card viewport',async()=>{
 const m={...meeting,transcript:Array.from({length:65},(_,i)=>'A：第 '+i+' 段討論').join('\n')};const [,b]=await setup([],m);assert.equal(b.people[0].excerpts.length,65);assert.equal(b.people[0].excerpts.at(-1).lineIndex,64);
});

test('review counterexamples: absence of suggestions and tentative discussion are not commitments',async()=>{
 const m={...meeting,transcript:'A：沒有任何建議。\nA：我會考慮整理報告。\nA：我會提議更新表單。'};const [,b]=await setup([],m);assert.equal(b.tasks.length,0);assert.deepEqual(b.people[0].suggestions.map(s=>s.lineIndex),[2]);
});
