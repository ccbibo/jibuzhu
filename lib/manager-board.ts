import type { AttributionResult, AttributionSegment } from './attribution.ts';
import type { MeetingInput } from './task-types.ts';
import { extractRules, meetingKey, InputError } from './task-engine.ts';

type Excerpt = { id: string; lineIndex: number; text: string };
type Candidate = { id: string; title: string; evidence: string; lineIndex: number; speakerId: string | null; speakerName: string | null; dueDate: string | null; assignee: null };
type Person = { id: string; name: string; identity: 'confirmed' | 'source'; excerpts: Excerpt[]; suggestions: Excerpt[]; tasks: Candidate[] };

/** A source-backed reading aid. Identity, a task commitment, and completion are separate claims. */
export async function buildManagerBoard(meeting: MeetingInput, attribution: AttributionResult) {
  if (await meetingKey(meeting) !== attribution.meetingId) throw new InputError('總覽與會議來源版本不一致。');
  const people = new Map<string, Person>();
  const unresolved: (Excerpt & { status: string })[] = [];
  const groupByLine = new Map<number, Person>();
  const excerpt = (s: AttributionSegment): Excerpt => ({ id: s.id, lineIndex: s.lineIndex, text: s.text });
  for (const s of attribution.segments) {
    const confirmed = s.status === 'confirmed' && s.person;
    // A continuation inherits a reading label, never identity. Disputed statements remain unresolved.
    const source = !confirmed && s.status !== 'disputed' && s.sourceLabelOrigin === 'explicit' && s.sourceLabel;
    if (!confirmed && !source) { unresolved.push({ ...excerpt(s), status: s.status }); continue; }
    const id = confirmed ? `person:${confirmed.id}` : `source:${source}`;
    if (!people.has(id)) people.set(id, { id, name: confirmed ? confirmed.name : `原文標記 ${source}（未確認身分）`, identity: confirmed ? 'confirmed' : 'source', excerpts: [], suggestions: [], tasks: [] });
    const person = people.get(id)!;
    person.excerpts.push(excerpt(s)); groupByLine.set(s.lineIndex, person);
    const statement = s.text.replace(/^\s*(?:\[[\d:]+\]\s*)?[^：:]{1,30}[：:]\s*/, '');
    // These are literal suggestion cues for review, never a decision or AI summary.
    if (/(?:建議|提議|不如|可以考慮)/.test(statement) && !/(?:(?:沒有|沒|並無|無)(?:任何|其他|新的|更多)?建議|不是建議|不(?:提出)?建議|撤回|取消)/.test(statement)) person.suggestions.push(excerpt(s));
  }
  const extraction = await extractRules({ ...meeting, mode: 'rules' });
  const tasks: Candidate[] = extraction.tasks.filter(t => !/(?:考慮|提議|建議|打算討論)/.test(t.evidence)).map(t => {
    const person = groupByLine.get(t.lineIndex);
    const s = attribution.segments.find(s => s.lineIndex === t.lineIndex);
    const task: Candidate = { id: t.id, title: t.title, evidence: t.evidence, lineIndex: t.lineIndex,
      speakerId: s?.status === 'confirmed' ? s.person?.id ?? null : null,
      speakerName: s?.status === 'confirmed' ? s.person?.name ?? null : null,
      dueDate: t.dueDate, assignee: null };
    person?.tasks.push(task);
    return task;
  });
  return { people: [...people.values()], unresolved, tasks,
    notice: '原文摘錄與建議線索供審閱；待辦僅為規則候選，說話者不等於負責人，完成狀態須另行人工更新。' };
}
