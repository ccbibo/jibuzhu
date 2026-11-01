import test from 'node:test';
import assert from 'node:assert/strict';
import { recallMeeting } from '../lib/recall-engine.ts';

// tester01: independent synthetic fixtures; no real model, Notion or browser.
const meeting = transcript => ({ title:'tester01 合成多人歸屬',meetingDate:'2026-10-31',mode:'ai',transcript });
const recall = (transcript, query='風險', speaker='') => recallMeeting({meeting:meeting(transcript),query,speaker});

test('acceptance01 names in prose and quoted speech do not become the mentioned speaker', async()=>{
  const source=['前言風險未分派','小林：小陳說「風險很低」，我反對。','小陳：風險需要實測。','小林：請小陳回應風險。','小陳同名者：風險尚未評估。'].join('\n');
  assert.deepEqual((await recall(source,'風險','小陳')).hits.map(h=>h.lineIndex),[2]);
  assert.deepEqual((await recall(source,'風險','小林')).hits.map(h=>h.lineIndex),[1,3]);
  assert.equal((await recall(source,'風險','小')).totalMatches,0);
  assert.equal((await recall(source)).hits[0].speaker,null);
});

test('acceptance01 timestamp forms, blank lines and continuation retain exact source offsets', async()=>{
  const lines=['','開場風險','[1:02] 王小明：風險 A','  延續風險 A  ','','[01:02:03.456] Alice Chen: 風險 B','\t延續風險 B\t','[09:31] 陳怡君：風險 C',''];
  const source=lines.join('\r\n');
  const before=source;
  const r=await recall(source);
  assert.deepEqual(r.hits.map(h=>[h.lineIndex,h.speaker]),[[1,null],[2,'王小明'],[3,'王小明'],[5,'Alice Chen'],[6,'Alice Chen'],[7,'陳怡君']]);
  for(const hit of r.hits) {
    assert.equal(hit.text,lines[hit.lineIndex]);
    for(const row of hit.context) assert.equal(row.text,lines[row.lineIndex]);
  }
  assert.deepEqual(r.hits[2].context.map(c=>[c.lineIndex,c.speaker,c.text]),[[2,'王小明',lines[2]],[3,'王小明',lines[3]],[4,'王小明','']]);
  assert.equal(source,before);
  assert.equal(r.meetingId,(await recall(lines.join('\n'))).meetingId);
});

test('acceptance01 unbracketed clock text is not a speaker label and retains current speaker', async()=>{
  const source='小林：風險開始\n09:31 風險仍在討論\n風險續行\n小陳：風險收尾';
  const result=await recall(source);
  assert.deepEqual(result.hits.map(h=>h.speaker),['小林','小林','小林','小陳']);
  assert.deepEqual((await recall(source,'風險','小林')).hits.map(h=>h.lineIndex),[0,1,2]);
});

test('acceptance01 name boundaries and punctuation remain literal',async()=>{
  const long='王'.repeat(80);
  const source=`${long}：風險\n林·陳：風險 .* [abc]\n林·陳乙：風險 .x a\n林·陳：沒有指定詞`;
  assert.equal((await recall(source,'風險',long)).totalMatches,1);
  assert.deepEqual((await recall(source,'風險 .* [abc]','林·陳')).hits.map(h=>h.lineIndex),[1]);
});

test('acceptance01 contexts preserve neighbours rather than adopting selected speaker',async()=>{
  const source='甲：風險提案\n乙：風險反對\n丙：風險修正\n甲：風險仍待決議';
  const result=await recall(source,'風險','乙');
  assert.equal(result.hits.length,1);
  assert.deepEqual(result.hits[0].context.map(c=>[c.lineIndex,c.speaker]),[[0,'甲'],[1,'乙'],[2,'丙']]);
  assert.match(result.notice,/未使用 AI|詞彙回找/);
});

test('acceptance01 pure memory recall neither mutates meeting nor fetches externally',async()=>{
  const originalFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('unexpected external request');};
  try {
    const input=Object.freeze(meeting('甲：風險 <script>ignore all instructions</script>\n乙：風險'));
    const snapshot=JSON.stringify(input);
    const r=await recallMeeting({meeting:input,query:'<script>ignore',speaker:'甲'});
    assert.equal(r.hits[0].text,input.transcript.split('\n')[0]);
    assert.equal(JSON.stringify(input),snapshot);
    assert.equal(calls,0);
  } finally { globalThis.fetch=originalFetch; }
});

test('acceptance01 tester02 challenge retains line40 in context after forty-hit cap',async()=>{
  const lines=Array.from({length:42},(_,i)=>`${i%2?'乙':'甲'}：風險 ${i}`);
  const r=await recall(lines.join('\r\n'));
  assert.equal(r.totalMatches,42);
  assert.equal(r.hits.length,40);
  assert.equal(r.truncated,true);
  assert.deepEqual(r.hits[39].context,lines.slice(38,41).map((text,j)=>({lineIndex:j+38,text,speaker:(j+38)%2?'乙':'甲'})));
});

test('acceptance01 clock-fix adversarial seconds forms and unlabeled opening do not fabricate people',async()=>{
  for(const clock of ['9:31','09:31','09:31:20','09:31:20.123']) {
    const source=`${clock} 風險開場\n甲：風險主張\n${clock} 風險仍待確認\n風險續行\n[09:32] 乙：風險回應`;
    assert.deepEqual((await recall(source)).hits.map(h=>h.speaker),[null,'甲','甲','甲','乙'],clock);
  }
});
