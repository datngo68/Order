import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from './db';
import { AppError, ensure } from './errors';
import { lockedOrder, receipt } from './orders';
import type { Prisma } from '@/generated/prisma/client';
export function bankConfigured(){return !!(process.env.APIBANK_BASE_URL&&process.env.APIBANK_API_KEY&&process.env.APIBANK_BANK_ACCOUNT_ID&&process.env.APIBANK_WEBHOOK_SECRET);}
function base(){const url=new URL(process.env.APIBANK_BASE_URL??'');ensure(url.protocol==='https:'||(process.env.NODE_ENV!=='production'&&process.env.APIBANK_ALLOW_HTTP==='1'),'APIBank cần HTTPS.',503);return url;}
const providerSchema=z.object({id:z.string().min(1),amount_vnd:z.coerce.number().int().positive(),status:z.enum(['pending','paid','review','expired','canceled','cancelled']),code:z.string().optional(),transfer_content:z.string().nullable().optional(),pay_url:z.string().nullable().optional(),expired_at:z.string().optional(),paid_at:z.string().nullable().optional(),paid_tx_id:z.string().nullable().optional(),bank_account_id:z.string().optional()});
export type ProviderOrder=z.infer<typeof providerSchema>;
const activePaymentStates=['NEW','PENDING','ERROR','VERIFYING'];
async function bankRequest(path:string,init:RequestInit={}){
 ensure(bankConfigured(),'Chưa cấu hình kết nối APIBank.',503);const response=await fetch(new URL(path,base()),{...init,cache:'no-store',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+process.env.APIBANK_API_KEY,'Content-Type':'application/json',...init.headers}});
 if(!response.ok)throw new AppError(502,'APIBank chưa xử lý được yêu cầu (HTTP '+response.status+'). Đơn vẫn được giữ để thử lại.');return providerSchema.parse(await response.json());
}
function safePayUrl(path:string|null|undefined){ensure(path,'APIBank chưa trả đường dẫn thanh toán.',502);const url=new URL(path,base());ensure(url.origin===base().origin&&url.pathname.startsWith('/pay/'),'Đường dẫn thanh toán không hợp lệ.',502);return url.toString();}
export async function beginPayment(orderId:string){
 ensure(bankConfigured(),'Chưa cấu hình APIBank. Vui lòng liên hệ quán.',503);
 const attempt=await db.$transaction(async tx=>{
  const order=await lockedOrder(tx,orderId);ensure(order.status==='CONFIRMED'&&order.paymentStatus==='UNPAID'&&order.paymentMethod==='TRANSFER'&&order.paymentMode==='APIBANK','Đơn chưa sẵn sàng thanh toán online.',409);ensure(order.total>0,'Đơn không cần thanh toán.');
  const reviews=await tx.paymentAttempt.findMany({where:{orderId,state:'REVIEW'},select:{externalId:true}});
  const unresolved=await tx.bankEvent.count({where:{state:'REVIEW',externalOrderId:{in:reviews.flatMap(review=>review.externalId?[review.externalId]:[])}}});
  ensure(!unresolved,'Quán đang kiểm tra giao dịch trước đó. Vui lòng liên hệ quán trước khi thanh toán thêm.',409);
  const existing=await tx.paymentAttempt.findFirst({where:{orderId,state:{in:activePaymentStates}},orderBy:{createdAt:'desc'}});if(existing)return existing;
  const count=await tx.paymentAttempt.count({where:{orderId,createdAt:{gte:new Date(Date.now()-3600000)}}});ensure(count<10,'Đã tạo quá nhiều yêu cầu thanh toán. Vui lòng liên hệ quán.',429);
  const created=await tx.paymentAttempt.create({data:{orderId,amount:order.total,idempotencyKey:'order-'+order.id+'-'+crypto.randomUUID()}});await tx.order.update({where:{id:orderId},data:{priceLockedAt:new Date(),version:{increment:1}}});return created;
 });
 await createRemote(attempt.id);return db.paymentAttempt.findUniqueOrThrow({where:{id:attempt.id}});
}
export async function createRemote(id:string){
 const claim=await db.paymentAttempt.updateMany({where:{id,externalId:null,state:{in:activePaymentStates},OR:[{leaseUntil:null},{leaseUntil:{lt:new Date()}}]},data:{leaseUntil:new Date(Date.now()+30000)}});if(!claim.count)return;
 const attempt=await db.paymentAttempt.findUniqueOrThrow({where:{id},include:{order:true}});
 try{
  const remote=await bankRequest('/v1/orders',{method:'POST',headers:{'Idempotency-Key':attempt.idempotencyKey},body:JSON.stringify({amount_vnd:attempt.amount,bank_account_id:process.env.APIBANK_BANK_ACCOUNT_ID,description:'Don #'+attempt.order.number,customer_ref:attempt.orderId,metadata:{order_internal_id:attempt.orderId,payment_attempt_id:attempt.id},ttl_seconds:900})});
  ensure(remote.amount_vnd===attempt.amount,'Số tiền APIBank không khớp.',502);const payUrl=safePayUrl(remote.pay_url);const expiresAt=remote.expired_at?new Date(remote.expired_at):new Date(Date.now()+900000);ensure(Number.isFinite(+expiresAt),'Thời hạn thanh toán không hợp lệ.',502);
  await db.$transaction(async tx=>{
   await lockedOrder(tx,attempt.orderId);
   const current=await tx.paymentAttempt.findUniqueOrThrow({where:{id}});
   ensure(!current.externalId||current.externalId===remote.id,'Tham chiếu APIBank không khớp.',502);
   // A webhook may finish before the create request returns. Preserve its decision.
   const state=remote.status==='expired'?'EXPIRED':['canceled','cancelled'].includes(remote.status)?'CANCELLED':remote.status==='review'?'VERIFYING':'PENDING';
   await tx.paymentAttempt.update({where:{id},data:{externalId:remote.id,payUrl,transferContent:remote.transfer_content??remote.code??'',expiresAt,leaseUntil:null,...(activePaymentStates.includes(current.state)?{state,lastError:null,nextPollAt:new Date(Date.now()+60000)}:{})}});
  });
  if(remote.status==='paid')await reconcilePaid(remote);
 }catch(e){await db.paymentAttempt.updateMany({where:{id,state:{in:activePaymentStates}},data:{leaseUntil:null,lastError:e instanceof AppError?e.message:'Mất kết nối APIBank. Hệ thống sẽ thử lại.',errorCount:{increment:1},nextPollAt:new Date(Date.now()+60000)}});throw e;}
}
export function verifyBankSignature(raw:Buffer,header:string|null,secret:string,now=Math.floor(Date.now()/1000)){
 if(!header||!secret||raw.length>128000)return false;const match=/^t=(\d{1,12}),v1=([a-fA-F0-9]{64})$/.exec(header);if(!match||Math.abs(now-Number(match[1]))>300)return false;const expected=createHmac('sha256',secret).update(match[1]+'.').update(raw).digest();return timingSafeEqual(expected,Buffer.from(match[2],'hex'));
}
const eventSchema=z.object({id:z.string().min(1).max(200),type:z.literal('payment.succeeded'),created_at:z.string().optional(),data:z.object({order_id:z.string().min(1),transaction_id:z.string().min(1).max(200),amount_vnd:z.coerce.number().int().positive(),posted_at:z.string().nullable().optional(),metadata:z.record(z.string(),z.unknown()).optional()})});
export async function applyBankEvent(payload:unknown){
 const event=eventSchema.parse(payload);const data=event.data;
 try{return await db.$transaction(async tx=>{
  const existing=await tx.bankEvent.findFirst({where:{OR:[{id:event.id},{transactionId:data.transaction_id}]}});if(existing)return existing.state;
  let attempt=await tx.paymentAttempt.findFirst({where:{OR:[{externalId:data.order_id},...(typeof data.metadata?.payment_attempt_id==='string'?[{id:data.metadata.payment_attempt_id,externalId:null}]:[])]}});
  let reason:string|null=null;
  if(!attempt)reason='Không tìm thấy yêu cầu thanh toán tương ứng.';
  const order=attempt?await lockedOrder(tx,attempt.orderId):null;
  if(attempt)attempt=await tx.paymentAttempt.findUniqueOrThrow({where:{id:attempt.id}});
  if(attempt&&order){
   if(attempt.externalId&&attempt.externalId!==data.order_id)reason='Tham chiếu APIBank không khớp.';
   else if(attempt.state==='CANCELLED')reason='Giao dịch thuộc yêu cầu thanh toán đã hủy.';
   else if(attempt.state==='REVIEW')reason='Yêu cầu thanh toán đang cần đối soát thủ công.';
   else if(data.amount_vnd!==attempt.amount||data.amount_vnd!==order.total)reason='Số tiền không khớp đơn.';
   else if(data.metadata?.order_internal_id&&data.metadata.order_internal_id!==order.id)reason='Tham chiếu order không khớp.';
   else if(order.status==='CANCELLED'||order.status==='RECEIVED')reason='Tiền đến khi đơn đã hủy hoặc đang thay đổi.';
   else if(order.paymentStatus!=='UNPAID')reason='Đơn đã được ghi nhận thanh toán/hoàn tiền trước đó.';
  }
  const paidAt=new Date(data.posted_at??event.created_at??new Date().toISOString());if(!Number.isFinite(+paidAt)||+paidAt>Date.now()+300000)reason='Thời điểm giao dịch không hợp lệ.';
  if(attempt?.expiresAt&&+paidAt>+attempt.expiresAt)reason='Giao dịch phát sinh sau khi yêu cầu đã hết hạn.';
  await tx.bankEvent.create({data:{id:event.id,transactionId:data.transaction_id,externalOrderId:data.order_id,state:reason?'REVIEW':'APPLIED',reason,payload:event as unknown as Prisma.InputJsonValue}});
  if(!reason&&attempt&&order){await receipt(tx,order,'APIBANK',null,data.transaction_id,paidAt);await tx.paymentAttempt.update({where:{id:attempt.id},data:{state:'PAID',externalId:data.order_id,leaseUntil:null,lastError:null}});}
  else if(reason&&attempt&&attempt.state!=='PAID'){await tx.paymentAttempt.update({where:{id:attempt.id},data:{state:'REVIEW',externalId:attempt.externalId??data.order_id,leaseUntil:null,lastError:reason}});}
  return reason?'REVIEW':'APPLIED';
 });}catch(e){if(e&&typeof e==='object'&&'code' in e&&e.code==='P2002'){const saved=await db.bankEvent.findFirst({where:{OR:[{id:event.id},{transactionId:data.transaction_id}]}});if(saved)return saved.state;}throw e;}
}
async function reconcilePaid(remote:ProviderOrder){ensure(remote.paid_tx_id,'APIBank chưa trả mã giao dịch để đối soát.',502);return applyBankEvent({id:'reconcile_'+remote.paid_tx_id,type:'payment.succeeded',data:{order_id:remote.id,transaction_id:remote.paid_tx_id,amount_vnd:remote.amount_vnd,posted_at:remote.paid_at}});}
export async function cancelActivePayments(orderId:string){
 const attempts=await db.paymentAttempt.findMany({where:{orderId,state:{in:activePaymentStates}}});
 for(let attempt of attempts){if(!attempt.externalId){await createRemote(attempt.id);attempt=await db.paymentAttempt.findUniqueOrThrow({where:{id:attempt.id}});}ensure(attempt.externalId,'Đang tạo yêu cầu thanh toán. Vui lòng thử lại.',409);const remote=await bankRequest('/v1/orders/'+encodeURIComponent(attempt.externalId)+':cancel',{method:'POST'});ensure(remote.id===attempt.externalId&&remote.amount_vnd===attempt.amount,'Dữ liệu hủy thanh toán không khớp.',502);if(remote.status==='paid'){await reconcilePaid(remote);continue;}ensure(['canceled','cancelled','expired'].includes(remote.status),'Chưa thể hủy yêu cầu APIBank.',409);await db.paymentAttempt.updateMany({where:{id:attempt.id,state:{in:activePaymentStates}},data:{state:remote.status==='expired'?'EXPIRED':'CANCELLED',leaseUntil:null}});}
}
export async function paymentWorkerTick(){
 const attempts=await db.paymentAttempt.findMany({where:{state:{in:activePaymentStates},nextPollAt:{lte:new Date()}},take:30,orderBy:{nextPollAt:'asc'},include:{order:true}});
 for(const attempt of attempts){try{
  if(!attempt.externalId){await createRemote(attempt.id);continue;}
  const claimed=await db.paymentAttempt.updateMany({where:{id:attempt.id,state:{in:activePaymentStates},OR:[{leaseUntil:null},{leaseUntil:{lt:new Date()}}]},data:{leaseUntil:new Date(Date.now()+30000)}});if(!claimed.count)continue;
  const remote=await bankRequest('/v1/orders/'+encodeURIComponent(attempt.externalId));ensure(remote.id===attempt.externalId&&remote.amount_vnd===attempt.amount,'Dữ liệu đối soát không khớp.',502);
  if(remote.status==='paid')await reconcilePaid(remote);
  else if(['expired','canceled','cancelled'].includes(remote.status))await db.paymentAttempt.updateMany({where:{id:attempt.id,state:{in:activePaymentStates}},data:{state:remote.status==='expired'?'EXPIRED':'CANCELLED',leaseUntil:null}});
  else if(attempt.order.paymentStatus!=='UNPAID'||attempt.order.status==='CANCELLED')await cancelActivePayments(attempt.orderId);
  else await db.paymentAttempt.updateMany({where:{id:attempt.id,state:{in:activePaymentStates}},data:{state:remote.status==='review'?'VERIFYING':'PENDING'}});
  await db.paymentAttempt.updateMany({where:{id:attempt.id,state:{in:activePaymentStates}},data:{leaseUntil:null,nextPollAt:new Date(Date.now()+60000),errorCount:0,lastError:null}});
 }catch(e){const seconds=Math.min(300,60*2**Math.min(attempt.errorCount,3));await db.paymentAttempt.updateMany({where:{id:attempt.id,state:{in:activePaymentStates}},data:{leaseUntil:null,nextPollAt:new Date(Date.now()+seconds*1000),errorCount:{increment:1},lastError:e instanceof AppError?e.message:'Kết nối APIBank bị gián đoạn.'}});console.error('[payment-reconcile]',attempt.id,e instanceof AppError?e.message:'Connection error');}}
 await db.requestLimit.deleteMany({where:{expiresAt:{lt:new Date()}}});
}
