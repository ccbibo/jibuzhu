import type { MeetingInput, Task } from './task-types.ts';
import { digest } from './task-engine.ts';
import { NOTION_VERSION, notionPayload, providerFetch, ProviderError, safeNotionUrl, type NotionSchema, type ProviderConfig } from './providers.ts';

export type VerifyResult = {
  results: {taskId:string;status:'verified'|'mismatch'|'missing'|'failed';differences:string[];url?:string;message?:string}[];
  retryAfter?:string;
};
const invalid=()=>new ProviderError('Notion 讀回資料不完整或格式無效，未能完成核對。');
function textOf(value:unknown):string {
  if(!Array.isArray(value)) throw invalid();
  return value.map(part=>{
    if(!part || part.type!=='text' || typeof part.text?.content!=='string') throw invalid();
    // Compare source text, without trusting plain_text or rendered HTML.
    return part.text.content;
  }).join('');
}
function sameId(a:unknown,b:string|undefined):boolean {
  if(typeof a!=='string' || !b)return false;
  const normalize=(v:string)=>/^[0-9a-f-]{32,36}$/i.test(v)?v.replaceAll('-','').toLowerCase():v;
  return normalize(a)===normalize(b);
}

/** Independent readback: never consult receipts or write/claim a page. */
export async function verifyTasks(userId:string,meeting:MeetingInput,tasks:Task[],config:ProviderConfig,schema:NotionSchema,fetcher:typeof fetch=fetch):Promise<VerifyResult> {
  if(!config.notionToken || !config.dataSourceId)throw new ProviderError('尚未設定 Notion 連線；目前可審閱與匯出。',503);
  const headers={Authorization:`Bearer ${config.notionToken}`,'Content-Type':'application/json','Notion-Version':NOTION_VERSION};
  const results:VerifyResult['results']=[];
  let throttled=false,retryAfter:string|undefined;
  for(const task of tasks){
    if(throttled){results.push({taskId:task.id,status:'failed',differences:[],message:'Notion 限流，本項尚未讀回。請稍後重試。'});continue;}
    try {
      const sourceId=`actiondesk:${await digest(`${userId}\n${config.dataSourceId}\n${task.id}`)}`;
      const query=await providerFetch(`https://api.notion.com/v1/data_sources/${encodeURIComponent(config.dataSourceId)}/query`,{method:'POST',headers,body:JSON.stringify({filter:{property:'來源 ID',rich_text:{equals:sourceId}},page_size:2})},fetcher);
      if(!Array.isArray(query.results) || typeof query.has_more!=='boolean')throw invalid();
      if(query.results.length>1 || query.has_more){results.push({taskId:task.id,status:'mismatch',differences:['來源 ID 重複：無法唯一定位 Notion 頁面。']});continue;}
      if(query.results.length===0){results.push({taskId:task.id,status:'missing',differences:['找不到相同來源 ID 的 Notion 頁面。']});continue;}
      const id=query.results[0]?.id;
      if(typeof id!=='string' || !id)throw invalid();
      const page=await providerFetch(`https://api.notion.com/v1/pages/${encodeURIComponent(id)}`,{method:'GET',headers},fetcher);
      if(page.id!==id || !page.properties || typeof page.properties!=='object' || Array.isArray(page.properties))throw invalid();
      const differences:string[]=[];
      if(page.archived===true || page.in_trash===true)differences.push('頁面已封存或移至垃圾桶。');
      if(page.parent?.type!=='data_source_id' || !sameId(page.parent?.data_source_id,config.dataSourceId))differences.push('頁面不屬於目前的 Notion 資料來源。');
      const expected=notionPayload(config,schema,task,meeting,sourceId) as {properties:Record<string,any>;children:{paragraph:{rich_text:unknown}}[]};
      for(const [name,want] of Object.entries(expected.properties)){
        const got=page.properties[name];
        let equal=false;
        if(got && typeof got==='object'){
          if('title' in want) equal=got.type==='title' && textOf(got.title)===textOf(want.title);
          else if('rich_text' in want) equal=got.type==='rich_text' && textOf(got.rich_text)===textOf(want.rich_text);
          else if('date' in want) equal=got.type==='date' && (want.date===null?got.date===null:got.date?.start===want.date.start && got.date?.end===null && got.date?.time_zone===null);
          else if('select' in want) equal=got.type==='select' && got.select?.name===want.select.name;
        }
        if(!equal)differences.push(`欄位「${name}」與目前審閱內容不同。`);
      }
      const blocks:any[]=[];const cursors=new Set<string>();let cursor:string|undefined;
      for(let pageNumber=0;;pageNumber++){
        if(pageNumber>=20)throw invalid();
        const params=new URLSearchParams({page_size:'100'});if(cursor)params.set('start_cursor',cursor);
        const children=await providerFetch(`https://api.notion.com/v1/blocks/${encodeURIComponent(id)}/children?${params}`,{method:'GET',headers},fetcher);
        if(!Array.isArray(children.results) || typeof children.has_more!=='boolean')throw invalid();
        blocks.push(...children.results);if(blocks.length>1000)throw invalid();
        if(!children.has_more)break;
        if(typeof children.next_cursor!=='string' || !children.next_cursor || cursors.has(children.next_cursor))throw invalid();
        cursor=children.next_cursor;cursors.add(cursor);
      }
      if(blocks.length!==expected.children.length)differences.push('來源內容段落數量不同（應為四段完整原文資料）。');
      const labels=['會議與會議日期','原文依據與行號','負責人與截止日期原文','審閱註記與來源 ID'];
      for(let i=0;i<expected.children.length;i++){
        const block=blocks[i];
        if(!block || block.type!=='paragraph' || block.has_children===true || block.archived===true || block.in_trash===true || textOf(block.paragraph?.rich_text)!==textOf(expected.children[i].paragraph.rich_text))differences.push(`段落「${labels[i]}」與目前審閱內容不同。`);
      }
      results.push({taskId:task.id,status:differences.length?'mismatch':'verified',differences,url:safeNotionUrl(page.url)});
    }catch(error){
      if(error instanceof ProviderError && error.status===429){throttled=true;retryAfter=error.retryAfter??undefined;}
      results.push({taskId:task.id,status:'failed',differences:[],message:error instanceof ProviderError?error.message:'Notion 讀回未完成，請稍後再試。'});
    }
  }
  return retryAfter?{results,retryAfter}:{results};
}
