import { randomBytes, createHash } from 'node:crypto';
import { db, type Tx } from './db';
import type { Actor } from './auth';
import { AppError, ensure } from './errors';
import { buildItems, calculateTotals, orderInputSchema, type OrderInput, type SnapshotLine } from './domain';
import type { Order, Prisma } from '@/generated/prisma/client';
import { lockedVisit } from './tables';
export const orderInclude={events:{orderBy:{createdAt:'asc' as const}},attempts:{orderBy:{createdAt:'desc' as const}},delivery:{include:{expense:true}},records:true,tableVisit:{select:{token:true,closedAt:true,table:{select:{name:true,active:true}}}}};
export async function lockedOrder(tx:Tx,id:string){await tx.$queryRawUnsafe('SELECT id FROM "Order" WHERE id = $1 FOR UPDATE',id);const order=await tx.order.findUnique({where:{id}});ensure(order,'Không tìm thấy đơn.',404);return order;}
export async function quote(input:OrderInput,taxBps:number,shipping:number){
 const products=await db.product.findMany({where:{id:{in:input.items.map(i=>i.productId)},category:{active:true}}});const items=buildItems(input.items,products);const code=input.couponCode.trim().toUpperCase();const coupon=code?await db.coupon.findUnique({where:{code}}):null;ensure(!code||coupon,'Mã giảm giá không tồn tại.');return {items,couponCode:code||null,...calculateTotals(items,coupon,taxBps,input.type==='DELIVERY'?shipping:0)};
}
export async function createOrder(input:OrderInput,staff:Actor|null){
 const source=staff?'POS':input.tableVisitToken?'TABLE_QR':'CUSTOMER';const requestHash=createHash('sha256').update(JSON.stringify({input,source})).digest('hex');const existing=await db.order.findUnique({where:{creationKey:input.key}});if(existing){ensure(existing.requestHash===requestHash,'Mã yêu cầu đã dùng cho nội dung khác.',409);return existing;}
 const shop=await db.shop.upsert({where:{id:'main'},create:{id:'main'},update:{}});ensure(staff||shop.acceptingOrders,'Quán đang tạm ngưng nhận đơn.');const pricing=await quote(input,shop.taxBps,0);
 try{return await db.$transaction(async tx=>{
  const context=input.tableVisitToken?await lockedVisit(tx,input.tableVisitToken):null;
  if(context){
   ensure(input.type==='DINE_IN','QR bàn chỉ dùng để gọi món tại bàn.');
   ensure(!context.visit.billRequestedAt,'Bàn đã gọi thanh toán. Nhờ nhân viên mở lại nếu muốn gọi thêm món.',409);
  }
  return tx.order.create({data:{...pricing,items:pricing.items as unknown as Prisma.InputJsonValue,creationKey:input.key,requestHash,token:randomBytes(24).toString('base64url'),source,type:input.type,paymentMethod:input.paymentMethod,paymentMode:shop.paymentMode,customerName:input.customerName.trim(),phone:input.phone.trim(),address:input.address.trim(),tableName:context?.table.name??input.tableName.trim(),tableVisitId:context?.visit.id,note:input.note,events:{create:{action:'CREATED',actorId:staff?.id,note:staff?'Nhân viên tạo đơn':context?'Khách gọi món qua QR bàn':'Khách gửi đơn'}},...(input.type==='DELIVERY'?{delivery:{create:{}}}:{})}});
 });}catch(e){const retry=await db.order.findUnique({where:{creationKey:input.key}});if(retry&&retry.requestHash===requestHash)return retry;throw e;}
}
function requireVersion(order:Order,version:number){ensure(order.version===version,'Đơn vừa được cập nhật ở thiết bị khác. Vui lòng tải lại.',409);}
export async function receipt(tx:Tx,order:Order,method:string,actorId:string|null,reference:string|null,paidAt=new Date()){
 ensure(order.paymentStatus==='UNPAID','Đơn đã được ghi nhận thanh toán.',409);
 await tx.paymentRecord.create({data:{orderId:order.id,kind:'RECEIPT',method,amount:order.total,subtotal:order.subtotal,discount:order.discount,tax:order.tax,shipping:order.shipping,actorId,reference,paidAt}});
 await tx.order.update({where:{id:order.id},data:{paymentStatus:'PAID',queuedAt:order.queuedAt??(order.status==='CONFIRMED'?new Date():null),version:{increment:1}}});
 await tx.orderEvent.create({data:{orderId:order.id,actorId,action:'PAYMENT_RECEIVED',note:method==='APIBANK'?'APIBank xác nhận thanh toán':'Đã ghi nhận tiền'}});
}
export async function confirmOrder(id:string,version:number,staff:Actor,taxBps:number,shipping:number){
 const old=await db.order.findUnique({where:{id}});ensure(old,'Không tìm thấy đơn.',404);const lines=old.items as unknown as SnapshotLine[];
 const input=orderInputSchema.parse({key:old.creationKey,type:old.type,paymentMethod:old.paymentMethod,customerName:old.customerName,phone:old.phone,address:old.address,tableName:old.tableName,note:old.note,couponCode:old.couponCode??'',items:lines.map(l=>({productId:l.productId,quantity:l.quantity,selected:l.options.map(o=>o.id),note:l.note}))});
 const pricing=await quote(input,taxBps,shipping);const shop=await db.shop.findUniqueOrThrow({where:{id:'main'}});
 return db.$transaction(async tx=>{const order=await lockedOrder(tx,id);requireVersion(order,version);ensure(order.status==='RECEIVED'&&order.paymentStatus==='UNPAID','Đơn không còn ở trạng thái chờ xác nhận.',409);const confirmed=await tx.order.update({where:{id},data:{...pricing,items:pricing.items as unknown as Prisma.InputJsonValue,status:'CONFIRMED',confirmedAt:new Date(),paymentMode:shop.paymentMode,queuedAt:order.paymentMethod!=='TRANSFER'||pricing.total===0?new Date():null,version:{increment:1}}});await tx.orderEvent.create({data:{orderId:id,actorId:staff.id,action:'CONFIRMED',note:'Đã chốt món, thuế và phí giao hàng'}});if(confirmed.total===0)await receipt(tx,confirmed,'FREE',staff.id,null);return tx.order.findUniqueOrThrow({where:{id},include:orderInclude});});
}
export async function editOrder(id:string,version:number,staff:Actor,input:OrderInput){
 const shop=await db.shop.findUniqueOrThrow({where:{id:'main'}});const pricing=await quote(input,shop.taxBps,0);
 return db.$transaction(async tx=>{
  const order=await lockedOrder(tx,id);requireVersion(order,version);
  ensure(order.status==='RECEIVED'&&!order.priceLockedAt&&order.paymentStatus==='UNPAID','Chỉ sửa đơn đang chờ xác nhận.',409);
  ensure(!order.tableVisitId||(input.type==='DINE_IN'&&input.tableName===order.tableName),'Đơn QR bàn phải giữ đúng bàn và hình thức tại bàn.',409);
  if(input.type==='DELIVERY')await tx.delivery.upsert({where:{orderId:id},create:{orderId:id},update:{}});
  else {
   const delivery=await tx.delivery.findUnique({where:{orderId:id},include:{expense:true}});
   ensure(!delivery?.expense,'Đã chi tiền giao hàng. Cần xử lý chi phí trước khi đổi hình thức nhận món.',409);
   if(delivery)await tx.delivery.delete({where:{id:delivery.id}});
  }
  await tx.order.update({where:{id},data:{...pricing,items:pricing.items as unknown as Prisma.InputJsonValue,type:input.type,paymentMethod:input.paymentMethod,customerName:input.customerName,phone:input.phone,address:input.address,tableName:input.tableName,note:input.note,version:{increment:1}}});
  await tx.orderEvent.create({data:{orderId:id,actorId:staff.id,action:'EDITED',note:'Cập nhật nội dung đơn'}});
  return tx.order.findUniqueOrThrow({where:{id},include:orderInclude});
 });
}
export async function orderAction(id:string,version:number,action:string,staff:Actor,note=''){
 return db.$transaction(async tx=>{const order=await lockedOrder(tx,id);requireVersion(order,version);const cashier=['OWNER','CASHIER'].includes(staff.role);let data:Prisma.OrderUpdateInput={version:{increment:1}};
 if(action==='start'){ensure(order.status==='CONFIRMED'&&order.queuedAt,'Đơn chưa đủ điều kiện vào bếp.',409);data.status='PREPARING';}
 else if(action==='ready'){ensure(order.status==='PREPARING','Đơn chưa được chế biến.',409);data.status='READY';}
 else if(action==='complete'){ensure(cashier&&order.status==='READY'&&order.type!=='DELIVERY','Chỉ hoàn thành đơn đã làm xong và giao tại quán.',409);data.status='COMPLETED';data.completedAt=new Date();}
 else if(action==='cancel'||action==='reopen'){
  ensure(cashier,'Không có quyền.',403);ensure(!['CANCELLED','COMPLETED'].includes(order.status),'Đơn đã kết thúc.',409);if(action==='reopen')ensure(order.paymentStatus==='UNPAID'&&order.status==='CONFIRMED','Chỉ mở lại đơn chưa thanh toán, chưa làm.',409);if(order.paymentStatus==='PAID'||order.status==='PREPARING'||order.status==='READY')ensure(staff.role==='OWNER','Chỉ chủ quán được hủy đơn đã trả tiền hoặc đang làm.',403);
  const active=await tx.paymentAttempt.count({where:{orderId:id,state:{in:['NEW','PENDING','ERROR','VERIFYING']}}});ensure(!active,'Yêu cầu thanh toán chưa hủy xong. Vui lòng thử lại.',409);
  data=action==='cancel'?{...data,status:'CANCELLED',cancelledAt:new Date()}:{...data,status:'RECEIVED',confirmedAt:null,queuedAt:null,priceLockedAt:null};ensure(note.trim().length>0,'Vui lòng ghi lý do.');
 }else if(action==='manual-pay'){
  ensure(cashier,'Không có quyền.',403);ensure(!['RECEIVED','CANCELLED'].includes(order.status),'Cần xác nhận đơn trước khi nhận tiền.',409);ensure(note.trim().length>0,'Ghi ghi chú xác nhận nhận tiền.');await receipt(tx,order,order.paymentMethod,staff.id,null);await tx.audit.create({data:{actorId:staff.id,action:'MANUAL_PAYMENT',targetId:id,detail:{note}}});return tx.order.findUniqueOrThrow({where:{id},include:orderInclude});
 }else if(action==='refund'){
  ensure(staff.role==='OWNER','Chỉ chủ quán được ghi hoàn tiền.',403);ensure(order.paymentStatus==='PAID'&&order.status==='CANCELLED','Hủy đơn đã thanh toán trước khi ghi hoàn tiền.',409);ensure(note.trim().length>0,'Ghi thông tin hoàn tiền.');await tx.paymentRecord.create({data:{orderId:id,kind:'REFUND',method:'MANUAL',amount:order.total,subtotal:order.subtotal,discount:order.discount,tax:order.tax,shipping:order.shipping,actorId:staff.id,note}});data.paymentStatus='REFUNDED';
 }else throw new AppError(400,'Thao tác không hợp lệ.');
 await tx.order.update({where:{id},data});await tx.orderEvent.create({data:{orderId:id,actorId:staff.id,action:action.toUpperCase(),note}});return tx.order.findUniqueOrThrow({where:{id},include:orderInclude});
 });
}
export function customerOrder(order:Awaited<ReturnType<typeof getOrder>>){
 const {id,number,token,type,status,paymentStatus,paymentMethod,paymentMode,customerName,phone,address,tableName,note,items,subtotal,discount,taxBps,tax,shipping,total,couponCode,createdAt,confirmedAt,queuedAt,completedAt}=order;
 const attempt=order.attempts[0];return {id,number,token,type,status,paymentStatus,paymentMethod,paymentMode,customerName,phone,address,tableName,note,items,subtotal,discount,taxBps,tax,shipping,total,couponCode,createdAt,confirmedAt,queuedAt,completedAt,tableVisit:order.tableVisit,delivery:order.delivery?{status:order.delivery.status,courier:order.delivery.courier,courierPhone:order.delivery.courierPhone}:null,events:order.events.map(e=>({action:e.action,createdAt:e.createdAt})),payment:attempt?{id:attempt.id,state:attempt.state,payUrl:attempt.state==='PENDING'?attempt.payUrl:null,transferContent:attempt.transferContent,expiresAt:attempt.expiresAt,externalId:attempt.externalId}:null};
}
export async function getOrder(id:string){const order=await db.order.findUnique({where:{id},include:orderInclude});ensure(order,'Không tìm thấy đơn.',404);return order;}
