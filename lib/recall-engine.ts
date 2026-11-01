import { InputError, validateMeeting, meetingKey } from './task-engine.ts';

export interface RecallLine { lineIndex: number; speaker: string | null; text: string }
export interface RecallResult {
  mode: 'literal'; meetingId: string; query: string; speaker: string;
  totalMatches: number; truncated: boolean;
  hits: (RecallLine & { context: RecallLine[] })[]; notice: string;
}

/** Parse declared labels only; unbracketed clocks are continuation text. */
export function sourceLines(transcript: string): RecallLine[] {
  let current: string | null = null;
  return transcript.replace(/\r\n/g, '\n').split('\n').map((text, lineIndex) => {
    // A bracketed timestamp is optional; prose mentions and unmarked time are not labels.
    const label = text.match(/^(?:\[\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\]\s*)?([^\s\[\]：:][^\[\]：:\r\n]{0,79})[：:]/u);
    if (label && !/^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s|$)/u.test(text)) current = label[1].trim();
    return { lineIndex, text, speaker: current };
  });
}

/** Literal source retrieval only: never invokes a provider or infers attribution. */
export async function recallMeeting(raw: unknown): Promise<RecallResult> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('請提供回找條件。');
  const body = raw as Record<string, unknown>;
  const meeting = validateMeeting(body.meeting);
  if (typeof body.query !== 'string' || !body.query.trim() || body.query.trim().length > 200) throw new InputError('關鍵詞須為 1–200 字元。');
  if (typeof body.speaker !== 'string' || body.speaker.trim().length > 80) throw new InputError('人物須為文字且最多 80 字元。');
  const query = body.query.trim(), speaker = body.speaker.trim();
  const terms = query.toLowerCase().split(/\s+/u);
  if (terms.length > 8) throw new InputError('最多輸入 8 個關鍵詞。');
  const lines = sourceLines(meeting.transcript);
  const matches = lines.filter(line => (!speaker || line.speaker === speaker) && terms.every(term => line.text.toLowerCase().includes(term)));
  return {
    mode: 'literal', meetingId: await meetingKey(meeting), query, speaker,
    totalMatches: matches.length, truncated: matches.length > 40,
    hits: matches.slice(0, 40).map(line => ({ ...line, context: lines.slice(Math.max(0, line.lineIndex - 1), line.lineIndex + 2) })),
    notice: '詞彙回找：僅比對原文關鍵詞與顯式人物標記，未使用 AI 或推論共識；上下文可能包含其他人物。無命中不代表會議未討論此問題。',
  };
}
