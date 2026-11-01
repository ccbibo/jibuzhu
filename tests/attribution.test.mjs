import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttribution } from '../lib/attribution.ts';
import { digest, meetingKey } from '../lib/task-engine.ts';

const meeting = {title:'合成認領',meetingDate:'2026-10-31',mode:'rules',transcript:'無標記 我是小王\r\nA：我叫小林。\r\n\r\nA：再次發言\r\n09:30 時鐘不是人物\r\nB：另一人'};
const participants = [{id:'alice',name:'小王'},{id:'bob',name:'小王'}];
const base = () => buildAttribution(meeting,participants,[]);
const event = (id,actorId,action,...segmentIds) => ({id,actorId,action,segmentIds});
const propose = (id,actorId,targetId,...segmentIds) => ({...event(id,actorId,'propose',...segmentIds),targetId});
const replay = async (make, m = meeting) => {
  const {segments} = await buildAttribution(m,participants,[]);
  return buildAttribution(m,participants,make(segments.map(s=>s.id)));
};
test('source labels and literal self-introduction clues never identify a person',async()=>{
  const result=await base();
  assert.equal(result.provenance,'demo');assert.equal(result.meetingId,await meetingKey(meeting));
  assert.deepEqual(result.segments.map(s=>s.lineIndex),[0,1,3,4,5]);
  assert.deepEqual(result.segments.map(s=>s.sourceLabel),[null,'A','A','A','B']);
  assert.equal(result.segments[0].text,'無標記 我是小王');
  assert.match(result.segments[0].hints[0],/我是小王/);
  assert.match(result.segments[1].hints[0],/我叫小林/);
  for(const s of result.segments){assert.equal(s.person,null);assert.equal(s.status,'unclaimed');assert.deepEqual(s.claimants,[]);assert.equal(s.id,await digest(`${result.meetingId}\n${s.lineIndex}\n${s.text}`));}
  const plain=await buildAttribution({...meeting,transcript:'09:30 我是小王\n10:00 我叫小林'},participants,[]);
  assert.deepEqual(plain.segments.map(s=>s.sourceLabel),[null,null]);
});
test('identity is deterministic, preserves whitespace, and every ID changes on source version change',async()=>{
  const original=await base();
  assert.deepEqual(await base(),original);
  const normalized=await buildAttribution({...meeting,title:'改標題',mode:'ai',transcript:meeting.transcript.replace(/\r\n/g,'\n')},participants,[]);
  assert.deepEqual(normalized.segments,original.segments);
  for(const changed of [{...meeting,transcript:meeting.transcript+'\n新增'}, {...meeting,meetingDate:'2026-11-01'}]) {
    const newer=await buildAttribution(changed,participants,[]);
    assert.ok(newer.segments.every(s=>!original.segments.some(old=>old.id===s.id)));
    await assert.rejects(()=>buildAttribution(changed,participants,[event('stale','alice','claim',original.segments[0].id)]));
  }
  const spaces=await buildAttribution({...meeting,transcript:'  A：保留空白  '},participants,[]);
  assert.equal(spaces.segments[0].text,'  A：保留空白  ');
});
test('explicit claim, own confirmation, repeated claim and withdrawal lifecycle',async()=>{
  const pending=await replay(([id])=>[event('1','alice','claim',id)]);
  assert.equal(pending.segments[0].status,'pending');assert.equal(pending.segments[0].person,null);
  const confirmed=await replay(([id])=>[event('1','alice','claim',id),event('2','alice','confirm',id),event('3','alice','claim',id)]);
  assert.equal(confirmed.segments[0].status,'confirmed');assert.deepEqual(confirmed.segments[0].person,participants[0]);
  assert.equal(confirmed.audit.at(-1).outcome,'ignored');
  const withdrawn=await replay(([id])=>[event('1','alice','claim',id),event('2','alice','confirm',id),event('3','alice','retract',id)]);
  assert.equal(withdrawn.segments[0].status,'unclaimed');assert.equal(withdrawn.segments[0].person,null);
});
test('same names are distinct IDs; conflict and retraction cannot revive an old confirmation',async()=>{
  const prefix=id=>[event('1','alice','claim',id),event('2','alice','confirm',id),event('3','bob','claim',id)];
  const disputed=await replay(([id])=>[...prefix(id),event('4','bob','confirm',id)]);
  assert.equal(disputed.segments[0].status,'disputed');assert.equal(disputed.segments[0].person,null);
  assert.deepEqual(disputed.segments[0].claimants,participants);assert.equal(disputed.audit.at(-1).outcome,'ignored');
  const pending=await replay(([id])=>[...prefix(id),event('4','bob','retract',id)]);
  assert.equal(pending.segments[0].status,'pending');assert.equal(pending.segments[0].person,null);
  const reconfirmed=await replay(([id])=>[...prefix(id),event('4','bob','retract',id),event('5','alice','confirm',id)]);
  assert.equal(reconfirmed.segments[0].status,'confirmed');assert.equal(reconfirmed.segments[0].person.id,'alice');
});
test('confirmation without claim and retracting another actor never overwrite their attribution',async()=>{
  const result=await replay(([id])=>[event('1','alice','claim',id),event('2','alice','confirm',id),event('3','bob','retract',id),event('4','bob','confirm',id)]);
  assert.equal(result.segments[0].person.id,'alice');
  assert.deepEqual(result.audit.slice(-2).map(a=>a.outcome),['ignored','ignored']);
  assert.ok(result.audit.slice(-2).every(a=>a.message));
});
test('teammate proposals require the target to claim and confirm personally',async()=>{
  const suggested=await replay(([id])=>[propose('1','alice','bob',id),event('2','bob','confirm',id),event('3','alice','confirm',id)]);
  assert.deepEqual(suggested.segments[0].proposals,[{actorId:'alice',targetId:'bob'}]);
  assert.deepEqual(suggested.segments[0].claimants,[]);
  assert.equal(suggested.segments[0].status,'unclaimed');assert.equal(suggested.segments[0].person,null);
  assert.deepEqual(suggested.audit.map(a=>a.outcome),['applied','ignored','ignored']);
  assert.equal(suggested.audit[0].targetId,'bob');
  const pending=await replay(([id])=>[propose('1','alice','bob',id),event('2','bob','claim',id),event('3','alice','confirm',id)]);
  assert.equal(pending.segments[0].status,'pending');assert.equal(pending.segments[0].person,null);
  const confirmed=await replay(([id])=>[propose('1','alice','bob',id),event('2','bob','claim',id),event('3','bob','confirm',id)]);
  assert.equal(confirmed.segments[0].status,'confirmed');assert.deepEqual(confirmed.segments[0].person,participants[1]);
  assert.deepEqual(confirmed.segments[0].proposals,[{actorId:'alice',targetId:'bob'}]);
});
test('different proposals coexist, updates affect only the author, and claims keep their own conflict rules',async()=>{
  const people=[...participants,{id:'carol',name:'小林'}];
  const {segments}=await base();const [id,other]=segments.map(s=>s.id);
  const events=[event('1','bob','claim',id),event('2','bob','confirm',id),
    propose('3','alice','bob',id,other),propose('4','carol','alice',id),propose('5','alice','carol',id),propose('6','alice','carol',id)];
  const before=JSON.stringify(events);
  const result=await buildAttribution(meeting,people,events);
  assert.deepEqual(result.segments[0].proposals,[{actorId:'alice',targetId:'carol'},{actorId:'carol',targetId:'alice'}]);
  assert.deepEqual(result.segments[1].proposals,[{actorId:'alice',targetId:'bob'}]);
  assert.equal(result.segments[0].person.id,'bob');assert.equal(result.segments[0].status,'confirmed');
  assert.deepEqual(result.audit.slice(2).map(a=>a.targetId),['bob','bob','alice','carol','carol']);
  assert.equal(result.audit.at(-1).outcome,'ignored');assert.equal(JSON.stringify(events),before);
  const disputed=await buildAttribution(meeting,people,[...events,event('7','carol','claim',id),event('8','bob','confirm',id)]);
  assert.equal(disputed.segments[0].status,'disputed');assert.equal(disputed.segments[0].person,null);
  assert.deepEqual(disputed.segments[0].proposals,result.segments[0].proposals);
});
test('withdrawing a proposal only removes the acting author and never changes real attribution',async()=>{
  const result=await replay(([id])=>[propose('1','alice','bob',id),event('2','bob','withdraw-proposal',id),
    event('3','bob','claim',id),event('4','bob','confirm',id),propose('5','bob','alice',id),event('6','alice','withdraw-proposal',id)]);
  assert.equal(result.audit[1].outcome,'ignored');
  assert.deepEqual(result.segments[0].proposals,[{actorId:'bob',targetId:'alice'}]);
  assert.deepEqual(result.segments[0].claimants,[participants[1]]);
  assert.equal(result.segments[0].person.id,'bob');assert.equal(result.segments[0].status,'confirmed');
  assert.ok(result.audit.filter(a=>a.action!=='propose').every(a=>!Object.hasOwn(a,'targetId')));
  const retracted=await replay(([id])=>[propose('1','alice','bob',id),event('2','alice','retract',id)]);
  assert.deepEqual(retracted.segments[0].proposals,[{actorId:'alice',targetId:'bob'}]);
});
test('proposal target validation rejects whole batches and cannot forge confirmation or withdrawal',async()=>{
  const {segments}=await base();const id=segments[0].id;
  const invalid=[event('bad','alice','propose',id),propose('bad','alice','unknown',id),propose('bad','alice',null,id),
    {...event('bad','bob','confirm',id),targetId:'alice'},
    {...event('bad','bob','claim',id),targetId:'alice'},
    {...event('bad','bob','retract',id),targetId:'alice'},
    {...event('bad','bob','withdraw-proposal',id),targetId:'alice'},
    {...event('bad','bob','confirm',id),targetId:undefined}];
  for(const bad of invalid) {
    await assert.rejects(()=>buildAttribution(meeting,participants,[event('first','alice','claim',id),bad]),/整次認領未套用/);
  }
  await assert.rejects(()=>buildAttribution(meeting,participants,[propose('self','alice','alice',id)]),/claim/);
  assert.ok((await base()).segments.every(s=>s.proposals.length===0&&s.status==='unclaimed'));
});
test('same source label only offers a reminder; explicit selection alone permits multiple claims',async()=>{
  const result=await replay((ids)=>[event('1','alice','claim',ids[1]),event('2','alice','confirm',ids[1])]);
  assert.equal(result.segments[1].status,'confirmed');
  for(const index of [2,3]){assert.equal(result.segments[index].status,'unclaimed');assert.equal(result.segments[index].person,null);assert.ok(result.segments[index].hints.some(h=>h.includes('同原文標記')));}
  const selected=await replay(ids=>[event('1','alice','claim',ids[1],ids[2]),event('2','alice','confirm',ids[1],ids[2])]);
  assert.equal(selected.segments.filter(s=>s.person).length,2);
});
test('rejects all invalid identities, actions, batches, duplicates, limits and foreign segments',async()=>{
  const {segments}=await base();const id=segments[0].id;
  const badPeople=[null,{},Array(51).fill(participants[0]),[participants[0],participants[0]],[{id:'',name:'x'}],[{id:'a',name:' '}],[{id:'a'.repeat(81),name:'x'}],[{id:'a',name:'x'.repeat(81)}]];
  for(const people of badPeople) await assert.rejects(()=>buildAttribution(meeting,people,[]));
  const good=event('valid','alice','claim',id);
  const badEvents=[null,{},Array(501).fill(good),[good,good],[{...good,id:''}],[{...good,id:'x'.repeat(161)}],[{...good,actorId:'mallory'}],[{...good,actorId:null}],[{...good,action:'assign'}],[{...good,segmentIds:[]}],[{...good,segmentIds:Array(101).fill(id)}],[{...good,segmentIds:[id,id]}],[{...good,segmentIds:[id,'foreign']}],[{...good,segmentIds:[null]}],[good,{...good,id:'later',actorId:'mallory'}]];
  for(const events of badEvents) await assert.rejects(()=>buildAttribution(meeting,participants,events));
  await assert.rejects(()=>buildAttribution(meeting,participants,[],'client-says-real'));
  await assert.rejects(()=>buildAttribution({...meeting,transcript:' '},participants,[]));
  assert.ok((await base()).segments.every(s=>s.status==='unclaimed'));
});
test('accepts documented bounds and emits serializable safe source strings without mutating inputs',async()=>{
  const m={...meeting,transcript:Array.from({length:100},(_,i)=>`A：<script>字串${i}</script>`).join('\n')};
  const people=Array.from({length:50},(_,i)=>({id:String(i),name:'n'.repeat(80)}));
  const initial=await buildAttribution(m,people,[]);
  const ids=initial.segments.map(s=>s.id);
  const events=Array.from({length:500},(_,i)=>event(String(i).padStart(160,'0'),'0',i===499?'confirm':'claim',...ids));
  const before=JSON.stringify({m,people,events});
  const result=await buildAttribution(m,people,events,'notion');
  assert.equal(result.segments.filter(s=>s.status==='confirmed').length,100);
  assert.equal(result.audit.length,50000);assert.equal(result.segments[0].text,'A：<script>字串0</script>');
  assert.equal(JSON.stringify({m,people,events}),before);assert.doesNotThrow(()=>JSON.stringify(result));
});
