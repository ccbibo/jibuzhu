import type { Extraction, MeetingInput, Task } from './task-types.ts';

export class InputError extends Error {}
export const MAX_TRANSCRIPT = 45000;
export function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InputError(`${name}格式不正確或超過長度限制。`);
  return value.trim();
}
export function validateMeeting(value: unknown): MeetingInput {
  if (!value || typeof value !== 'object') throw new InputError('請提供會議內容。');
  const v = value as Record<string, unknown>;
  if (!isDate(v.meetingDate)) throw new InputError('請輸入有效的會議日期。');
  if (v.mode !== 'rules' && v.mode !== 'ai') throw new InputError('請選擇規則示範或 AI 模式。');
  bounded(v.transcript, '逐字稿', MAX_TRANSCRIPT); // Validate without altering source offsets or line numbers.
  return { title: bounded(v.title, '會議名稱', 180), transcript: v.transcript as string, meetingDate: v.meetingDate, mode: v.mode };
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function meetingKey(meeting: MeetingInput): Promise<string> {
  return digest(`${meeting.meetingDate}\n${meeting.transcript.replace(/\r\n/g, '\n')}`);
}
export async function taskKey(meetingId: string, lineIndex: number, evidence: string): Promise<string> {
  return digest(`${meetingId}\n${lineIndex}\n${evidence.trim()}`);
}
export function linesOf(transcript: string): string[] { return transcript.split(/\r?\n/); }
export function parseDue(text: string, meetingDate: string): {dueDate: string | null; dueText: string | null} {
  const dates = [...text.matchAll(/(20\d{2})[-\/]([01]?\d)[-\/]([0-3]?\d)/g)];
  const relativeDates = [...text.matchAll(/(明天|明日|後天|今天|今日)/g)];
  if (dates.length + relativeDates.length > 1) return { dueDate: null, dueText: [...dates.map(d=>d[0]),...relativeDates.map(d=>d[0])].join('、').slice(0,100) };
  const explicit = dates[0];
  if (explicit) {
    const date = `${explicit[1]}-${explicit[2].padStart(2, '0')}-${explicit[3].padStart(2, '0')}`;
    const before = text.slice(Math.max(0,explicit.index!-12),explicit.index);
    const after = text.slice(explicit.index!+explicit[0].length).trimStart();
    const deadlineContext = /(?:截止|期限|到期|於|在|到)(?:日期)?[：:\s]*$/.test(before) || /^(?:前|之前|完成|提交|寄送|交付|交稿|交出)/.test(after);
    return { dueDate: isDate(date) && deadlineContext ? date : null, dueText: explicit[0] };
  }
  const relative = text.match(/(明天|明日|後天|今天|今日)/);
  if (relative) {
    const base = new Date(`${meetingDate}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() + (relative[0] === '後天' ? 2 : /明/.test(relative[0]) ? 1 : 0));
    return { dueDate: base.toISOString().slice(0, 10), dueText: relative[0] };
  }
  const fuzzy = text.match(/(下(?:個)?[週周][一二三四五六日天]?|本[週周][一二三四五六日天]?|[週周][一二三四五六日天]|月底|下個月|盡快|近期|\d{1,2}月\d{1,2}[日號]|\d{1,2}\/\d{1,2})/);
  return { dueDate: null, dueText: fuzzy?.[0] ?? null };
}
function ownerIsNegated(line: string, owner: string): boolean {
  const name = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const negative = '(?:並非|不是|不再是|不負責|不再負責|無須負責)';
  return new RegExp(`${name}\\s*${negative}`).test(line) || new RegExp(`^\\s*${name}[：:]\\s*我\\s*${negative}`).test(line);
}
function ownerOf(line: string): string | null {
  const speaker = line.match(/^\s*(?:\[?[\d:]+\]?\s*)?([\p{L}][\p{L}\d· ]{0,15})[：:]\s*/u)?.[1]?.trim();
  let named = line.match(/(?:請|交給|由)\s*([\p{L}][\p{L}\d·]{0,10}?)(?:\s*(?:負責|協助|在|於|完成|整理|確認|製作|更新|寄送|聯繫|提交|提供))/u)?.[1];
  if (named) named = named.replace(/(?:今天|明天|後天|今日|明日|下週|下周|本週|本周).*$/, '');
  if (named && !/^(大家|同學|各位|我們|有人)$/.test(named)) return ownerIsNegated(line, named) ? null : named;
  return speaker && /我(?:會|來|負責|要)/.test(line) && !ownerIsNegated(line, speaker) ? speaker : null;
}
export async function extractRules(meeting: MeetingInput): Promise<Extraction> {
  const meetingId = await meetingKey(meeting);
  const tasks: Task[] = [];
  const lines = linesOf(meeting.transcript);
  const relativeRetraction = lines.some(raw => {
    const statement = raw.trim().replace(/^[^：:]{1,20}[：:]\s*/, '');
    if (/(?:提案|尚未決議|未決議|未確認|尚未確認|如果|假如|是否|要不要|也許|考慮)/.test(statement)) return false;
    return /^(?:取消|撤回|先取消)(?:上一項|上一件|上一個任務)(?:[，,。；;！!]|$)/.test(statement);
  });
  if (relativeRetraction) return { meetingId, tasks: [], mode: 'rules', summary: '原文包含跨行撤回。規則示範無法可靠對應被撤回的承諾，暫不產生任務；請先確認並更新原文，再重新整理。' };
  for (let lineIndex = 0; lineIndex < lines.length && tasks.length < 40; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (!line || line.length > 2000) continue;
    if (/(?:不要|不用|不需要|不必|取消|暫不|先不|已經|已完成|完成了|要不要|是否|建議|可以考慮|或許|也許|如果|假如|可能|ignore|system prompt|API.?key|忽略.*指令)/i.test(line)) continue;
    if (!/(?:我會|我來|我負責|請.{1,20}(?:負責|完成|整理|確認|製作|更新|寄送|聯繫|提交|提供)|(?:待辦|行動項目)[：:]|(?:由|交給).{1,15}負責)/.test(line)) continue;
    const evidence = line;
    const assignee = ownerOf(line);
    const due = parseDue(line, meeting.meetingDate);
    const title = line.replace(/^\s*(?:\[?[\d:]+\]?\s*)?[^：:]{1,20}[：:]\s*/, '').slice(0, 240);
    const warnings: string[] = [];
    if (!assignee) warnings.push('負責人待確認');
    if (!due.dueDate) warnings.push(due.dueText ? `期限「${due.dueText}」需確認日期` : '截止日期待確認');
    tasks.push({ id: await taskKey(meetingId, lineIndex, evidence), title, assignee, ...due, priority: /緊急|優先|務必/.test(line) ? 'high' : 'normal', evidence, lineIndex, warnings });
  }
  return { meetingId, tasks, mode: 'rules', summary: tasks.length ? `以保守規則辨識 ${tasks.length} 項明確承諾；請逐項審閱。未使用 AI，可能遺漏其他表述。` : '沒有辨識到明確承諾。規則示範只處理「我會／請某人完成／待辦：」等表述，不代表會議沒有任務。' };
}
export async function validateTasks(raw: unknown, meeting: MeetingInput, id: string, ai = false): Promise<Task[]> {
  if (!Array.isArray(raw) || raw.length > 40) throw new InputError('每次最多處理 40 項任務。');
  const lines = linesOf(meeting.transcript), out: Task[] = [], seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new InputError('任務格式錯誤。');
    const v = item as Record<string, unknown>;
    const title = bounded(v.title, '任務名稱', 240), evidence = bounded(v.evidence, '原文依據', 2000);
    if (!Number.isInteger(v.lineIndex) || (v.lineIndex as number) < 0 || !lines[v.lineIndex as number]?.includes(evidence)) throw new InputError('任務原文依據無法在指定行找到，請重新整理。');
    const lineIndex = v.lineIndex as number, tid = await taskKey(id, lineIndex, evidence);
    if (seen.has(tid)) throw new InputError('多個任務使用相同原文依據，請合併為一項或提供各自的原文子句，避免遺漏。');
    seen.add(tid);
    const optional = (value: unknown, field: string, max = 100) => value === null ? null : bounded(value, field, max);
    const assignee = optional(v.assignee, '負責人', 80);
    let dueDate = optional(v.dueDate, '截止日期');
    let dueText = optional(v.dueText, '原文期限');
    if (dueDate !== null && !isDate(dueDate)) throw new InputError('截止日期格式不正確。');
    if (!['high', 'normal', 'low'].includes(v.priority as string)) throw new InputError('優先級格式不正確。');
    const warnings = Array.isArray(v.warnings) ? v.warnings.filter((w): w is string => typeof w === 'string' && w.length < 180).slice(0, 6) : [];
    if(dueText&&!evidence.includes(dueText)){dueText=parseDue(evidence,meeting.meetingDate).dueText;warnings.push('期限文字未能在原文找到，已清除或改用原文期限');}
    let groundedOwner = assignee;
    if (ai) {
      if (groundedOwner && (!lines[lineIndex].includes(groundedOwner) || ownerOf(lines[lineIndex]) !== groundedOwner)) { groundedOwner = null; warnings.push('AI 負責人未能由原文明確確認，已清除'); }
      const parsed = parseDue(evidence, meeting.meetingDate);
      if (dueDate && dueDate !== parsed.dueDate) { dueDate = null; warnings.push('AI 日期未能由原文明確確認，已清除'); }
    }
    if (!groundedOwner && !warnings.includes('負責人待確認')) warnings.push('負責人待確認');
    if (!dueDate && !warnings.some(w => /日期|期限/.test(w))) warnings.push('截止日期待確認');
    out.push({ id: tid, title, assignee: groundedOwner, dueDate, dueText, priority: v.priority as Task['priority'], evidence, lineIndex, warnings });
  }
  return out;
}
