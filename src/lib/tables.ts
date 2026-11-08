import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db, type Tx } from './db';
import type { Actor } from './auth';
import { ensure } from './errors';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const newToken = () => randomBytes(24).toString('base64url');
const tableSchema = z.object({name:z.string().trim().min(1).max(30),area:z.string().trim().max(80).default(''),seats:z.number().int().min(1).max(30),active:z.boolean()});

export function tableQrUrl(token:string) {
  const base = new URL(process.env.APP_URL ?? 'http://127.0.0.1:3100');
  ensure(['https:','http:'].includes(base.protocol),'Địa chỉ website của quán không hợp lệ.',503);
  return new URL('/t/'+token,base.origin).toString();
}

export async function lockedTable(tx:Tx,id:string) {
  await tx.$queryRawUnsafe('SELECT id FROM "DiningTable" WHERE id = $1 FOR UPDATE',id);
  const table = await tx.diningTable.findUnique({where:{id}});
  ensure(table,'Không tìm thấy bàn.',404);
  return table;
}

export async function publicTable(qrToken:string) {
  ensure(tokenSchema.safeParse(qrToken).success,'Mã QR bàn không hợp lệ.',404);
  const table = await db.diningTable.findUnique({where:{qrToken},select:{id:true,name:true,area:true,seats:true,active:true}});
  ensure(table?.active,'Bàn đang tạm ngưng phục vụ hoặc QR đã được thay. Vui lòng liên hệ nhân viên.',404);
  return table;
}

export async function openTable(qrToken:string) {
  const ref = await publicTable(qrToken);
  return db.$transaction(async tx => {
    const table = await lockedTable(tx,ref.id);
    ensure(table.active && table.qrToken===qrToken,'QR bàn không còn hiệu lực.',409);
    const existing = await tx.tableVisit.findUnique({where:{activeTableId:table.id}});
    const visit = existing ?? await tx.tableVisit.create({data:{tableId:table.id,activeTableId:table.id,token:newToken()}});
    return {token:visit.token};
  });
}

export async function lockedVisit(tx:Tx,token:string) {
  ensure(tokenSchema.safeParse(token).success,'Lượt khách không hợp lệ.',404);
  const ref = await tx.tableVisit.findUnique({where:{token},select:{tableId:true}});
  ensure(ref,'Không tìm thấy lượt khách.',404);
  const table = await lockedTable(tx,ref.tableId);
  const visit = await tx.tableVisit.findUniqueOrThrow({where:{token}});
  ensure(table.active && !visit.closedAt && visit.activeTableId===table.id,'Lượt phục vụ đã kết thúc. Vui lòng quét lại QR tại bàn.',409);
  return {table,visit};
}

export async function publicVisit(token:string) {
  ensure(tokenSchema.safeParse(token).success,'Lượt khách không hợp lệ.',404);
  const visit = await db.tableVisit.findUnique({where:{token},include:{table:{select:{name:true,area:true,active:true}},orders:{orderBy:{createdAt:'asc'},select:{number:true,status:true,paymentStatus:true,items:true,total:true,createdAt:true}}}});
  ensure(visit,'Không tìm thấy lượt khách.',404);
  // A closed visit never reveals the next party's orders or customer details.
  const orders = visit.closedAt ? [] : visit.orders.map(order=>({...order,items:(order.items as unknown as {name:string;quantity:number;options:{name:string}[]}[]).map(item=>({name:item.name,quantity:item.quantity,options:item.options.map(option=>option.name)}))}));
  return {table:visit.table,openedAt:visit.openedAt,closedAt:visit.closedAt,billRequestedAt:visit.billRequestedAt,billAcknowledgedAt:visit.billAcknowledgedAt,orders,total:orders.filter(order=>order.status!=='CANCELLED').reduce((sum,order)=>sum+order.total,0),unpaid:orders.filter(order=>order.status!=='CANCELLED'&&order.paymentStatus==='UNPAID').reduce((sum,order)=>sum+order.total,0)};
}

export async function requestTableBill(token:string) {
  return db.$transaction(async tx=>{
    const {visit}=await lockedVisit(tx,token);
    ensure(await tx.order.count({where:{tableVisitId:visit.id,status:{not:'CANCELLED'}}}),'Bàn chưa có món đã gọi. Vui lòng gọi món trước.',409);
    if(visit.billRequestedAt)return {requestedAt:visit.billRequestedAt,acknowledgedAt:visit.billAcknowledgedAt};
    const updated=await tx.tableVisit.update({where:{id:visit.id},data:{billRequestedAt:new Date(),version:{increment:1}}});
    return {requestedAt:updated.billRequestedAt,acknowledgedAt:updated.billAcknowledgedAt};
  });
}

export async function listTables() {
  const tables=await db.diningTable.findMany({orderBy:[{area:'asc'},{name:'asc'}],include:{visits:{where:{closedAt:null},take:1,include:{orders:{orderBy:{createdAt:'asc'},select:{id:true,number:true,status:true,paymentStatus:true,total:true}}}}}});
  return tables.map(({visits,...table})=>({...table,qrUrl:tableQrUrl(table.qrToken),visit:visits[0]??null}));
}

export async function getTableBillVisit(tableId: string, visitId?: string) {
  return db.tableVisit.findUnique({
    where: visitId === undefined ? { activeTableId: tableId } : { id: visitId, tableId },
    include: { table: true, orders: { where: { status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'asc' } } },
  });
}

export async function saveTable(id:string|undefined,input:unknown,actor:Actor) {
  ensure(actor.role==='OWNER','Chỉ chủ quán được quản lý bàn.',403);
  const data=tableSchema.parse(input);
  return db.$transaction(async tx=>{
    if(id){
      const {version}=z.object({version:z.number().int().min(0)}).parse(input);
      const current=await lockedTable(tx,id);
      ensure(current.version===version,'Bàn vừa thay đổi. Vui lòng tải lại.',409);
      if(!data.active)ensure(!await tx.tableVisit.findUnique({where:{activeTableId:id}}),'Hãy kết thúc lượt khách trước khi tạm ngưng bàn.',409);
    }
    const table=id?await tx.diningTable.update({where:{id},data:{...data,version:{increment:1}}}):await tx.diningTable.create({data:{...data,qrToken:newToken()}});
    await tx.audit.create({data:{actorId:actor.id,action:id?'TABLE_UPDATED':'TABLE_CREATED',targetId:table.id}});
    return table;
  });
}

export async function rotateTableQr(id:string,input:unknown,actor:Actor) {
  ensure(actor.role==='OWNER','Chỉ chủ quán được đổi QR bàn.',403);
  const {version}=z.object({version:z.number().int().min(0)}).parse(input);
  return db.$transaction(async tx=>{
    const table=await lockedTable(tx,id);
    ensure(table.version===version,'Bàn vừa thay đổi. Vui lòng tải lại.',409);
    ensure(!await tx.tableVisit.findUnique({where:{activeTableId:id}}),'Hãy kết thúc lượt khách trước khi đổi QR.',409);
    const result=await tx.diningTable.update({where:{id},data:{qrToken:newToken(),version:{increment:1}}});
    await tx.audit.create({data:{actorId:actor.id,action:'TABLE_QR_ROTATED',targetId:id}});
    return result;
  });
}

export async function tableVisitAction(id:string,action:string,input:unknown,actor:Actor) {
  ensure(['OWNER','CASHIER'].includes(actor.role),'Không có quyền quản lý lượt khách.',403);
  const {version}=z.object({version:z.number().int().min(0)}).parse(input);
  ensure(['acknowledge','resume','close'].includes(action),'Thao tác không hợp lệ.');
  return db.$transaction(async tx=>{
    const ref=await tx.tableVisit.findUnique({where:{id},select:{tableId:true}});ensure(ref,'Không tìm thấy lượt khách.',404);
    await lockedTable(tx,ref.tableId);
    if(action==='close')await tx.$queryRawUnsafe('SELECT id FROM "Order" WHERE "tableVisitId" = $1 ORDER BY id FOR UPDATE',id);
    const visit=await tx.tableVisit.findUniqueOrThrow({where:{id},include:{orders:{select:{status:true,paymentStatus:true}}}});
    ensure(!visit.closedAt && visit.version===version,'Lượt khách vừa thay đổi hoặc đã kết thúc. Vui lòng tải lại.',409);
    if(action==='acknowledge')ensure(visit.billRequestedAt,'Khách chưa yêu cầu thanh toán.',409);
    if(action==='close'){
      const reviews=await tx.paymentAttempt.findMany({where:{order:{tableVisitId:id},state:'REVIEW'},select:{externalId:true}});
      const unresolved=await tx.bankEvent.count({where:{externalOrderId:{in:reviews.flatMap(attempt=>attempt.externalId?[attempt.externalId]:[])},state:'REVIEW',resolvedAt:null}});
      ensure(!unresolved,'Còn giao dịch thanh toán cần đối soát. Vui lòng xử lý trước khi kết thúc lượt khách.',409);
    }
    if(action==='close')ensure(visit.orders.every(order=>order.status==='CANCELLED'?order.paymentStatus!=='PAID':order.status==='COMPLETED'&&order.paymentStatus==='PAID'),'Cần hoàn tất món và ghi nhận đủ thanh toán/hoàn tiền cho các đơn trước khi kết thúc lượt khách.',409);
    const data=action==='close'?{closedAt:new Date(),activeTableId:null}:action==='resume'?{billRequestedAt:null,billAcknowledgedAt:null}:{billAcknowledgedAt:visit.billAcknowledgedAt??new Date()};
    const updated=await tx.tableVisit.update({where:{id},data:{...data,version:{increment:1}}});
    await tx.audit.create({data:{actorId:actor.id,action:'TABLE_VISIT_'+action.toUpperCase(),targetId:id}});
    return updated;
  });
}
