import type { MeetingInput, SyncResult, Task } from './task-types.ts';
import { digest } from './task-engine.ts';
import { createNotionPage, findNotionPage, ProviderError, type ProviderConfig, type NotionSchema } from './providers.ts';
export type Receipt = {state:string;notion_page_id:string|null;notion_url:string|null};
export interface ReceiptStore {
  get(key:string,userId:string):Promise<Receipt|null>;
  // Atomically insert a new receipt OR reclaim state='failed'; never reclaim pending/uncertain/success.
  claim(key:string,userId:string):Promise<boolean>;
  finish(key:string,userId:string,state:string,page?:{id:string,url?:string}):Promise<void>;
}
export function d1Store(db:D1Database):ReceiptStore {
  return {
    get:async(key,userId)=>db.prepare('SELECT state, notion_page_id, notion_url FROM sync_receipts WHERE key = ? AND user_id = ?').bind(key,userId).first<Receipt>(),
    claim:async(key,userId)=> {const r=await db.prepare("INSERT INTO sync_receipts (key,user_id,state,updated_at) VALUES (?,?,'pending',?) ON CONFLICT(key) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at WHERE sync_receipts.user_id = excluded.user_id AND sync_receipts.state = 'failed'").bind(key,userId,Date.now()).run();return (r.meta.changes??0)===1;},
    finish:async(key,userId,state,page)=> {await db.prepare('UPDATE sync_receipts SET state = ?, notion_page_id = ?, notion_url = ?, updated_at = ? WHERE key = ? AND user_id = ?').bind(state,page?.id??null,page?.url??null,Date.now(),key,userId).run();},
  };
}
export async function syncTasks(userId:string,meeting:MeetingInput,tasks:Task[],c:ProviderConfig,schema:NotionSchema,store:ReceiptStore,fetcher:typeof fetch=fetch,reconcileOnly=false):Promise<SyncResult> {
  const results:SyncResult['results']=[];
  let throttled=false;
  let retryAfter:string|undefined;
  const captureThrottle=(error:unknown)=>{
    if(error instanceof ProviderError && error.status===429){throttled=true;retryAfter=error.retryAfter??undefined;}
  };
  for(const task of tasks){
    if(throttled){results.push({taskId:task.id,status:'failed',message:retryAfter?`Notion 限流，本項尚未送出。請依 Retry-After（${retryAfter}）稍後重試。`:'Notion 限流，本項尚未送出。請稍後重試。'});continue;}
    const key=await digest(`${userId}\n${c.dataSourceId}\n${task.id}`);
    const sourceId=`actiondesk:${key}`;
    try {
      const receipt=await store.get(key,userId);
      if(receipt?.state==='success'){results.push({taskId:task.id,status:'existing',url:receipt.notion_url??undefined,message:'此任務已同步，未重複建立。'});continue;}
      const existing=await findNotionPage(c,sourceId,fetcher);
      if(existing){
        if(!receipt && !reconcileOnly)await store.claim(key,userId);
        if(receipt || !reconcileOnly)await store.finish(key,userId,'success',existing);
        results.push({taskId:task.id,status:'existing',url:existing.url,message:'已找到相同來源任務，未重複建立。'});continue;
      }
      if(reconcileOnly){results.push({taskId:task.id,status:'uncertain',message:'查核模式未找到相同來源任務；尚未新增任何頁面。請確認原資料來源或人工查核。'});continue;}
      if(receipt && receipt.state!=='failed'){results.push({taskId:task.id,status:'uncertain',message:'先前寫入正在處理或結果不明。請在 Notion 查核；系統不自動重送。'});continue;}
      if(!await store.claim(key,userId)){results.push({taskId:task.id,status:'uncertain',message:'相同任務正在處理，請稍後查核。'});continue;}
      try {
        const page=await createNotionPage(c,schema,task,meeting,sourceId,fetcher);
        await store.finish(key,userId,'success',page);
        results.push({taskId:task.id,status:'created',url:page.url});
      }catch(error){
        // Explicit provider rejections (e.g. 400/401/429) did not create a page.
        // Transport errors, 5xx, malformed success, and receipt persistence failures remain uncertain.
        const state=error instanceof ProviderError && !error.uncertain?'failed':'uncertain';
        await store.finish(key,userId,state).catch(()=>{});
        captureThrottle(error);
        results.push({taskId:task.id,status:state,message:error instanceof ProviderError?error.message:'寫入結果尚未確認，請先在 Notion 查核，避免重複建立。'});
      }
    }catch(error){captureThrottle(error);results.push({taskId:task.id,status:'failed',message:error instanceof ProviderError?error.message:'尚未完成任務查核，未再次送出寫入。'});}
  }
  return retryAfter?{results,retryAfter}:{results};
}
