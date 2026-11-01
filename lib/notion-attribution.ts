import { buildAttribution, type AttributionEvent, type AttributionParticipant } from './attribution.ts';
import { validateMeeting } from './task-engine.ts';
import { providerFetch, ProviderError, NOTION_VERSION, type ProviderConfig } from './providers.ts';

type ClaimConfig = ProviderConfig & { claimPageId?: string };
const invalid = () => new ProviderError('Notion 認領留言資料不完整，沒有套用部分身分結果。');
const sameId = (a: unknown,b: string) => typeof a==='string' && a.replaceAll('-','').toLowerCase()===b.replaceAll('-','').toLowerCase();
/** Reads account-authored statements, never treats an open-comment snapshot as a complete identity ledger. */
export async function previewNotionAttribution(raw: unknown, config: ClaimConfig, fetcher: typeof fetch = fetch) {
  const meeting=validateMeeting(raw);
  if(!config.notionToken || !config.claimPageId)throw new ProviderError('尚未設定 Notion 認領頁。請設定 NOTION_TOKEN 與 NOTION_CLAIM_PAGE_ID，並授予讀取留言與使用者資料權限。',503);
  if(!/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(config.claimPageId))throw new ProviderError('Notion 認領頁 ID 格式不正確。',422);
  const base=await buildAttribution(meeting,[],[],'notion');
  const known=new Set(base.segments.map(s=>s.id));
  const headers={Authorization:`Bearer ${config.notionToken}`,'Notion-Version':NOTION_VERSION};
  const comments:Record<string,any>[]=[];const cursors=new Set<string>();const commentIds=new Set<string>();let cursor:string|undefined;
  for(let page=0;;page++){
    if(page>=10)throw invalid();
    const query=new URLSearchParams({block_id:config.claimPageId,page_size:'100'});if(cursor)query.set('start_cursor',cursor);
    const data=await providerFetch(`https://api.notion.com/v1/comments?${query}`,{method:'GET',headers},fetcher);
    if(!Array.isArray(data.results)||typeof data.has_more!=='boolean')throw invalid();
    for(const c of data.results){
      if(!c || c.object!=='comment' || typeof c.id!=='string' || !c.id || commentIds.has(c.id))throw invalid();
      commentIds.add(c.id);
      if(!sameId(c.parent?.page_id,config.claimPageId) || c.parent?.type!=='page_id')throw invalid();
      comments.push(c);
    }
    if(!data.has_more)break;
    if(typeof data.next_cursor!=='string'||!data.next_cursor||cursors.has(data.next_cursor))throw invalid();
    cursors.add(data.next_cursor);cursor=data.next_cursor;
  }
  const warnings=['只讀此頁頂層未解決留言；已解決、已刪除及區塊留言不在此快照。','留言作者只代表 Notion 帳號聲明，不能單靠留言或姓名證明真實聲音身分。','此快照不是完整認領／撤回歷史；所有單人確認暫列待確認，不供人物歸屬回找。'];
  const candidates:{event:AttributionEvent;time:number}[]=[];
  for(const c of comments){
    if(!Array.isArray(c.rich_text))throw invalid();
    if(!c.rich_text.every((t:any)=>t?.type==='text'&&typeof t.text?.content==='string'))continue;
    const content=c.rich_text.map((t:any)=>t.text.content).join('').trim();
    const m=content.match(/^記補住 (claim|confirm|retract) ([a-f0-9]{64}(?:,[a-f0-9]{64}){0,99})$/);
    if(!m)continue;
    const ids=m[2].split(',');
    if(ids.some(id=>!known.has(id)) || new Set(ids).size!==ids.length){warnings.push(`留言 ${c.id} 的來源版本或段落無效，整則略過。`);continue;}
    const time=Date.parse(c.last_edited_time);
    if(!Number.isFinite(time)||typeof c.created_by?.id!=='string'||!c.created_by.id)throw invalid();
    candidates.push({event:{id:`${c.id}@${c.last_edited_time}`,actorId:c.created_by.id,action:m[1] as AttributionEvent['action'],segmentIds:ids},time});
  }
  if(candidates.length>500)throw invalid();
  candidates.sort((a,b)=>a.time-b.time || a.event.id.localeCompare(b.event.id));
  const ids=[...new Set(candidates.map(c=>c.event.actorId))];if(ids.length>50)throw invalid();
  const participants:AttributionParticipant[]=[];const excluded=new Set<string>();
  for(const id of ids){
    const user=await providerFetch(`https://api.notion.com/v1/users/${encodeURIComponent(id)}`,{method:'GET',headers},fetcher);
    if(user.object!=='user'||!sameId(user.id,id))throw invalid();
    if(user.type!=='person'){excluded.add(id);warnings.push('已忽略整合機器人的認領聲明。');continue;}
    const name=typeof user.name==='string'&&user.name.trim()?user.name.slice(0,80):`Notion 成員 ${id.slice(-8)}`;
    participants.push({id,name});
  }
  const result=await buildAttribution(meeting,participants,candidates.map(c=>c.event).filter(e=>!excluded.has(e.actorId)),'notion');
  for(const segment of result.segments)if(segment.status==='confirmed'){
    segment.status='pending';segment.person=null;
    segment.hints.push('目前只看到未解決留言；缺少完整事件歷史，不升級為已確認歸屬。');
  }
  return {...result,participants,warnings,identityTrust:'open_comment_snapshot',notice:'Notion 帳號來源候選快照；不是已完成的本人身分驗證或完整協作紀錄。'};
}
