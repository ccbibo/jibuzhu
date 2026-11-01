import { digest, InputError, meetingKey, validateMeeting } from './task-engine.ts';
import { sourceLines } from './recall-engine.ts';

export type AttributionProvenance = 'demo' | 'notion';
export type AttributionStatus = 'unclaimed' | 'pending' | 'confirmed' | 'disputed';
export type AttributionParticipant = { id: string; name: string };
export type AttributionEvent = {
  id: string; actorId: string; action: 'claim' | 'confirm' | 'retract' | 'propose' | 'withdraw-proposal'; segmentIds: string[];
  targetId?: string;
};
export type AttributionSegment = {
  id: string; lineIndex: number; text: string; sourceLabel: string | null; sourceLabelOrigin: 'explicit' | 'continuation' | 'none';
  status: AttributionStatus; claimants: AttributionParticipant[];
  proposals: { actorId: string; targetId: string }[];
  person: AttributionParticipant | null; hints: string[];
};
export type AttributionAudit = {
  eventId: string; actorId: string; action: AttributionEvent['action']; segmentId: string;
  targetId?: string;
  outcome: 'applied' | 'ignored'; message: string;
};
export type AttributionResult = {
  meetingId: string; provenance: AttributionProvenance; segments: AttributionSegment[];
  audit: AttributionAudit[]; notice: string;
};

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function readParticipants(raw: unknown): AttributionParticipant[] {
  if (!Array.isArray(raw) || raw.length > 50) throw new InputError('參與者最多 50 人。');
  const seen = new Set<string>();
  return raw.map(value => {
    if (!object(value) || !validText(value.id, 80) || !validText(value.name, 80) || seen.has(value.id)) {
      throw new InputError('參與者 id／名稱須為 1–80 字元，且 id 不得重複。');
    }
    seen.add(value.id);
    return { id: value.id, name: value.name };
  });
}
function readEvents(raw: unknown, people: Set<string>, segments: Set<string>): AttributionEvent[] {
  if (!Array.isArray(raw) || raw.length > 500) throw new InputError('認領事件最多 500 筆。');
  const seen = new Set<string>();
  return raw.map(value => {
    if (!object(value) || !validText(value.id, 160) || seen.has(value.id)
      || typeof value.actorId !== 'string' || !people.has(value.actorId)
      || !['claim', 'confirm', 'retract', 'propose', 'withdraw-proposal'].includes(value.action as string)
      || (value.action === 'propose'
        ? typeof value.targetId !== 'string' || !people.has(value.targetId)
        : Object.hasOwn(value, 'targetId'))
      || !Array.isArray(value.segmentIds) || value.segmentIds.length < 1 || value.segmentIds.length > 100
      || new Set(value.segmentIds).size !== value.segmentIds.length
      || !value.segmentIds.every(id => typeof id === 'string' && segments.has(id))) {
      throw new InputError('認領事件格式、參與者或來源版本無效；整次認領未套用。');
    }
    if (value.action === 'propose' && value.actorId === value.targetId) {
      throw new InputError('不能替自己提出人物建議；請使用本人認領（claim）。整次認領未套用。');
    }
    seen.add(value.id);
    return { id: value.id, actorId: value.actorId, action: value.action as AttributionEvent['action'], segmentIds: [...value.segmentIds],
      ...(value.action === 'propose' ? { targetId: value.targetId as string } : {}),
    };
  });
}

/** Replays teammate suggestions separately from self-claims. Provenance must be selected by a trusted server adapter. */
export async function buildAttribution(
  rawMeeting: unknown, rawParticipants: unknown, rawEvents: unknown,
  provenance: AttributionProvenance = 'demo',
): Promise<AttributionResult> {
  if (provenance !== 'demo' && provenance !== 'notion') throw new InputError('來源僅限 demo 或 notion。');
  const meeting = validateMeeting(rawMeeting);
  const participants = readParticipants(rawParticipants);
  const meetingId = await meetingKey(meeting);
  const segments: AttributionSegment[] = await Promise.all(sourceLines(meeting.transcript)
    .filter(line => line.text.trim().length > 0)
    .map(async line => ({
      id: await digest(`${meetingId}\n${line.lineIndex}\n${line.text}`),
      lineIndex: line.lineIndex, text: line.text, sourceLabel: line.speaker,
      sourceLabelOrigin: (line.speaker===null?'none':sourceLines(line.text)[0]?.speaker===null?'continuation':'explicit') as AttributionSegment['sourceLabelOrigin'],
      status: 'unclaimed' as const, claimants: [], proposals: [], person: null,
      hints: [...(line.speaker!==null && sourceLines(line.text)[0]?.speaker===null?['此行沒有獨立人物標記；沿用上一段標記只供閱讀，不能證明同一人。']:[]), ...[...new Set(line.text.match(/(?:我是|我叫)[^\s，。！？；、：:,.!?;“”「」"'（）()<>]{1,80}/gu) ?? [])]
        .map(phrase => `原文逐字線索「${phrase}」；須本人認領與確認。`)],
    })));
  const byId = new Map(segments.map(segment => [segment.id, segment]));
  // Validate the entire batch before applying any event; stale or mixed-version IDs reject it all.
  const events = readEvents(rawEvents, new Set(participants.map(person => person.id)), new Set(byId.keys()));
  const people = new Map(participants.map(person => [person.id, person]));
  const audit: AttributionAudit[] = [];
  for (const event of events) {
    const actor = people.get(event.actorId)!;
    for (const segmentId of event.segmentIds) {
      const segment = byId.get(segmentId)!;
      const own = segment.claimants.some(person => person.id === actor.id);
      let outcome: AttributionAudit['outcome'] = 'applied';
      let message: string;
      if (event.action === 'propose') {
        const existing = segment.proposals.find(proposal => proposal.actorId === actor.id);
        if (existing?.targetId === event.targetId) {
          outcome = 'ignored'; message = '已存在相同人物建議；仍須目標本人認領與確認。';
        } else if (existing) {
          existing.targetId = event.targetId!;
          message = '已更新本人的人物建議；不影響認領，仍須目標本人認領與確認。';
        } else {
          segment.proposals.push({ actorId: actor.id, targetId: event.targetId! });
          message = '已新增人物建議；不代表本人認領，仍須目標本人認領與確認。';
        }
      } else if (event.action === 'withdraw-proposal') {
        if (segment.proposals.some(proposal => proposal.actorId === actor.id)) {
          segment.proposals = segment.proposals.filter(proposal => proposal.actorId !== actor.id);
          message = '已撤回本人的人物建議；不影響其他建議或認領。';
        } else {
          outcome = 'ignored'; message = '本人沒有可撤回的人物建議，不影響其他人的建議。';
        }
      } else if (event.action === 'claim') {
        if (own) {
          outcome = 'ignored'; message = '已存在本人的認領，保留目前狀態。';
        } else {
          segment.claimants.push({ ...actor }); segment.person = null;
          message = '已新增本人認領；仍須確認，衝突時不作人物歸屬。';
        }
      } else if (event.action === 'confirm') {
        if (!own || segment.claimants.length !== 1) {
          outcome = 'ignored'; message = own ? '多人認領有爭議，無法確認。' : '本人尚未認領，無法確認他人的聲明。';
        } else {
          segment.person = { ...actor }; message = '已確認本人唯一認領。';
        }
      } else if (own) {
        segment.claimants = segment.claimants.filter(person => person.id !== actor.id);
        segment.person = null;
        message = '已撤回本人認領；剩餘認領須重新確認。';
      } else {
        outcome = 'ignored'; message = '本人沒有可撤回的認領，不影響其他人的聲明。';
      }
      segment.status = segment.claimants.length > 1 ? 'disputed'
        : segment.claimants.length === 0 ? 'unclaimed'
        : segment.person ? 'confirmed' : 'pending';
      audit.push({ eventId: event.id, actorId: actor.id, action: event.action, segmentId,
        ...(event.action === 'propose' ? { targetId: event.targetId } : {}), outcome, message });
    }
  }
  const claimedLabels = new Set(segments.filter(segment => segment.claimants.length && segment.sourceLabel !== null).map(segment => segment.sourceLabel));
  for (const segment of segments) {
    if (segment.sourceLabel !== null && claimedLabels.has(segment.sourceLabel)) {
      segment.hints.push(`同原文標記「${segment.sourceLabel}」已有認領；不代表本段屬於同一人，須逐段明確選取與確認。`);
    }
  }
  return {
    meetingId, provenance, segments, audit,
    notice: `${provenance === 'demo' ? 'Demo 角色可切換，並非登入或真人身分驗證。' : 'Notion 帳號聲明僅由服務端授權來源讀取。'}原文標記、聲音分群與內容線索皆不能證明身分；只有已確認段落可供人物歸屬回找。認領不代表接受待辦指派，也不證明言論內容正確。`,
  };
}
