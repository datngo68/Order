import { z } from 'zod';
import Decimal from 'decimal.js';
import { db } from './db';
import { moneySchema, optionGroupsSchema } from './domain';
import { ensure } from './errors';
import type { Actor } from './auth';
import { bankConfigured } from './payments';
import type { Prisma } from '@/generated/prisma/client';
import { lockedOrder } from './orders';
const date=z.string().datetime({offset:true});
const productSchema=z.object({name:z.string().min(1).max(150),description:z.string().max(1000).default(''),categoryId:z.string().min(1),price:moneySchema,image:z.string().regex(/^\/(uploads|demo)\/[a-zA-Z0-9._-]+$/).nullable().optional(),available:z.boolean().default(true),active:z.boolean().default(true),sort:z.number().int().min(0).max(9999).default(0),optionGroups:optionGroupsSchema.default([])});
const couponSchema=z.object({code:z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,40}$/),type:z.enum(['PERCENT','FIXED']),value:moneySchema,minSubtotal:moneySchema.default(0),maxDiscount:moneySchema.nullable().default(null),startsAt:date.nullable().default(null),expiresAt:date.nullable().default(null),active:z.boolean().default(true)}).refine(c=>c.type!=='PERCENT'||c.value<=100,'Phần trăm giảm không vượt 100.').refine(c=>!c.startsAt||!c.expiresAt||c.startsAt<c.expiresAt,'Ngày kết thúc phải sau ngày bắt đầu.');
export async function saveResource(resource:string,id:string|undefined,input:unknown,actor:Actor){
 let result:unknown;
 if(resource==='products'){const data=productSchema.parse(input);result=id?await db.product.update({where:{id},data}):await db.product.create({data});}
 else if(resource==='categories'){const data=z.object({name:z.string().min(1).max(80),sort:z.number().int().min(0).max(9999).default(0),active:z.boolean().default(true)}).parse(input);result=id?await db.category.update({where:{id},data}):await db.category.create({data});}
 else if(resource==='coupons'){const parsed=couponSchema.parse(input);const data={...parsed,startsAt:parsed.startsAt?new Date(parsed.startsAt):null,expiresAt:parsed.expiresAt?new Date(parsed.expiresAt):null};result=id?await db.coupon.update({where:{id},data}):await db.coupon.create({data});}
 else if(resource==='ingredients'){const data=z.object({name:z.string().min(1).max(150),unit:z.string().min(1).max(30),supplier:z.string().max(200).default(''),unitPrice:moneySchema.default(0),active:z.boolean().default(true)}).parse(input);result=id?await db.ingredient.update({where:{id},data}):await db.ingredient.create({data});}
 else if(resource==='settings'){const data=z.object({name:z.string().min(1).max(120),tagline:z.string().max(200),phone:z.string().max(30),address:z.string().max(500),acceptingOrders:z.boolean(),taxBps:z.number().int().min(0).max(10000),paymentMode:z.enum(['MANUAL','APIBANK']),bankName:z.string().max(100),bankAccount:z.string().max(40),bankHolder:z.string().max(150)}).parse(input);ensure(data.paymentMode!=='APIBANK'||bankConfigured(),'Chưa cấu hình đầy đủ APIBank trên máy chủ.');result=await db.shop.upsert({where:{id:'main'},create:{id:'main',...data},update:data});}
 else throw new Error('Unknown resource');
 await db.audit.create({data:{actorId:actor.id,action:'SAVE_'+resource.toUpperCase(),targetId:id,detail:{}}});return result;
}
export async function createPurchase(input:unknown,actor:Actor){
 const parsed=z.object({supplier:z.string().min(1).max(200),note:z.string().max(1000).default(''),purchasedAt:date,paidAt:date.nullable(),items:z.array(z.object({ingredientId:z.string(),quantity:z.number().positive().max(1000000),unitPrice:moneySchema})).min(1).max(100)}).parse(input);
 const ingredients=await db.ingredient.findMany({where:{id:{in:parsed.items.map(i=>i.ingredientId)},active:true}});const items=parsed.items.map(item=>{const ing=ingredients.find(i=>i.id===item.ingredientId);ensure(ing,'Nguyên liệu không tồn tại.');const total=new Decimal(item.quantity).mul(item.unitPrice).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber();return {...item,name:ing.name,unit:ing.unit,total};});const total=items.reduce((s,i)=>s+i.total,0);moneySchema.parse(total);ensure(total>0,'Tổng phiếu mua phải lớn hơn 0.');
 return db.$transaction(async tx=>{const purchase=await tx.purchase.create({data:{supplier:parsed.supplier,note:parsed.note,purchasedAt:new Date(parsed.purchasedAt),paidAt:parsed.paidAt?new Date(parsed.paidAt):null,items:items as unknown as Prisma.InputJsonValue,total,actorId:actor.id}});if(purchase.paidAt)await tx.expense.create({data:{category:'INGREDIENT',amount:total,paidAt:purchase.paidAt,actorId:actor.id,purchaseId:purchase.id,note:'Nhập hàng: '+parsed.supplier}});return purchase;});
}
export async function payPurchase(id:string,input:unknown,actor:Actor){const {paidAt}=z.object({paidAt:date}).parse(input);return db.$transaction(async tx=>{const claimed=await tx.purchase.updateMany({where:{id,paidAt:null},data:{paidAt:new Date(paidAt)}});ensure(claimed.count,'Phiếu đã chi tiền hoặc không tồn tại.',409);const purchase=await tx.purchase.findUniqueOrThrow({where:{id}});return tx.expense.create({data:{purchaseId:id,category:'INGREDIENT',amount:purchase.total,paidAt:new Date(paidAt),actorId:actor.id,note:'Nhập hàng: '+purchase.supplier}});});}
export async function createExpense(input:unknown,actor:Actor){const data=z.object({category:z.enum(['RENT','UTILITY','SALARY','TRANSPORT','OTHER']),amount:moneySchema.refine(n=>n>0),note:z.string().min(1).max(1000),paidAt:date}).parse(input);return db.expense.create({data:{...data,paidAt:new Date(data.paidAt),actorId:actor.id}});}
export async function saveDelivery(id:string,input:unknown,actor:Actor){
 const data=z.object({version:z.number().int().min(0),courier:z.string().max(120),courierPhone:z.string().max(30),status:z.enum(['UNASSIGNED','ASSIGNED','IN_TRANSIT','DELIVERED','FAILED']),cost:moneySchema,note:z.string().max(1000).default(''),payCost:z.boolean().default(false)}).parse(input);
 return db.$transaction(async tx=>{
 const reference=await tx.delivery.findUnique({where:{id},select:{orderId:true}});ensure(reference,'Không có đơn giao hàng.',404);
 const order=await lockedOrder(tx,reference.orderId);
 const delivery=await tx.delivery.findUnique({where:{id},include:{expense:true}});ensure(delivery&&order.type==='DELIVERY','Không có đơn giao hàng.',404);
 ensure(!['RECEIVED','CANCELLED'].includes(order.status),'Chỉ điều phối đơn đã xác nhận và chưa hủy.',409);
 ensure(delivery.version===data.version,'Đơn giao vừa thay đổi. Vui lòng tải lại.',409);
 ensure(!delivery.expense||data.cost===delivery.cost,'Không sửa chi phí giao đã thanh toán.');if(['ASSIGNED','IN_TRANSIT','DELIVERED'].includes(data.status))ensure(data.courier.trim(),'Cần nhập người giao.');if(['IN_TRANSIT','DELIVERED'].includes(data.status))ensure(['READY','COMPLETED'].includes(order.status),'Bếp chưa làm xong đơn.');const transitions:Record<string,string[]>={UNASSIGNED:['UNASSIGNED','ASSIGNED'],ASSIGNED:['ASSIGNED','UNASSIGNED','IN_TRANSIT'],IN_TRANSIT:['IN_TRANSIT','DELIVERED','FAILED'],FAILED:['FAILED','ASSIGNED'],DELIVERED:['DELIVERED']};ensure(transitions[delivery.status]?.includes(data.status),'Chuyển trạng thái giao hàng không hợp lệ.');
 const updated=await tx.delivery.updateMany({where:{id,version:data.version},data:{courier:data.courier,courierPhone:data.courierPhone,status:data.status,cost:data.cost,note:data.note,version:{increment:1}}});ensure(updated.count,'Đơn giao vừa thay đổi. Vui lòng tải lại.',409);
 if(data.payCost&&!delivery.expense){ensure(data.cost>0,'Chi phí giao phải lớn hơn 0.');await tx.expense.create({data:{deliveryId:id,category:'TRANSPORT',amount:data.cost,paidAt:new Date(),actorId:actor.id,note:'Giao đơn #'+order.number+' - '+data.courier}});}
 if(data.status==='DELIVERED'&&order.status!=='COMPLETED')await tx.order.update({where:{id:order.id},data:{status:'COMPLETED',completedAt:new Date(),version:{increment:1}}});
 await tx.orderEvent.create({data:{orderId:order.id,action:'DELIVERY_'+data.status,actorId:actor.id,note:data.note}});return tx.delivery.findUniqueOrThrow({where:{id},include:{expense:true}});
 });
}
