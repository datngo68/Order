import { z } from 'zod';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { db } from '@/lib/db';
import { actor,body,handler,json,publicLimit,requestLimit,sameOrigin } from '@/lib/http';
import { auth } from '@/lib/auth';
import { readLimitedBody } from '@/lib/request-body';
import { ensure,AppError } from '@/lib/errors';
import { orderInputSchema } from '@/lib/domain';
import { createOrder,confirmOrder,editOrder,orderAction,customerOrder,getOrder,orderInclude,quote } from '@/lib/orders';
import { applyBankEvent,bankConfigured,beginPayment,cancelActivePayments,verifyBankSignature } from '@/lib/payments';
import { saveResource,setProductAvailability,createPurchase,payPurchase,createExpense,saveDelivery } from '@/lib/admin';
import { report,reportCsv } from '@/lib/reports';
import { vnDay } from '@/lib/format';
import { listTables,openTable,publicTable,publicVisit,requestTableBill,saveTable,rotateTableQr,tableVisitAction,tableQrUrl } from '@/lib/tables';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
function readPage(url: URL) {
  const page = Math.trunc(Number(url.searchParams.get('page')) || 1);
  return Math.max(1, Math.min(100_000, page));
}
async function track(token:string){ensure(/^[A-Za-z0-9_-]{32}$/.test(token),'Không tìm thấy đơn.',404);const order=await db.order.findUnique({where:{token},include:orderInclude});ensure(order,'Không tìm thấy đơn.',404);return order;}
export async function GET(request:Request,context:Context){return handler(async()=>{
 const parts=(await context.params).path;const route=parts.join('/');const url=new URL(request.url);
 if(route==='health'){await db.$queryRawUnsafe('SELECT 1');return json({ok:true});}
 if(route==='catalog'){const [shop,categories]=await Promise.all([db.shop.upsert({where:{id:'main'},create:{id:'main'},update:{}}),db.category.findMany({where:{active:true},orderBy:{sort:'asc'},include:{products:{where:{active:true},orderBy:[{sort:'asc'},{name:'asc'}]}}})]);return json({shop,categories});}
 if(route==='session')return json(await actor(request));
 if(route==='tables'){await actor(request,['OWNER','CASHIER']);return json(await listTables());}
 if(route==='table-alerts'){await actor(request,['OWNER','CASHIER']);return json({pending:await db.tableVisit.count({where:{closedAt:null,billRequestedAt:{not:null},billAcknowledgedAt:null}})});}
 if(parts[0]==='table'&&parts.length===2){await publicLimit(request,'table-info',120);return json(await publicTable(parts[1]));}
 if(parts[0]==='table-visits'&&parts.length===2){
  // Guests on the restaurant Wi-Fi share an IP. Budget normal polling per visit,
  // while keeping an IP-wide ceiling for invalid tokens and bulk requests.
  await publicLimit(request,'table-visit',3600);
  const visit=await publicVisit(parts[1]);
  await publicLimit(request,'table-visit:'+parts[1],360);
  return json(visit);
 }
 if(parts[0]==='tables'&&parts.length===3&&parts[2]==='qr'){
  await actor(request,['OWNER','CASHIER']);const table=await db.diningTable.findUnique({where:{id:parts[1]}});ensure(table,'Không tìm thấy bàn.',404);
  const svg=await QRCode.toString(tableQrUrl(table.qrToken),{type:'svg',errorCorrectionLevel:'M',margin:4,width:640});
  return new Response(svg,{headers:{'Content-Type':'image/svg+xml','Cache-Control':'private, no-store',...(url.searchParams.has('download')?{'Content-Disposition':'attachment; filename="table-'+table.id+'.svg"'}:{})}});
 }
 if(parts[0]==='track'&&parts.length===2){await publicLimit(request,'track',3600);const order=await track(parts[1]);await requestLimit('track-token',parts[1],60);return json(customerOrder(order));}
 if(route==='kitchen'){await actor(request);return json(await db.order.findMany({where:{status:{in:['CONFIRMED','PREPARING','READY']},queuedAt:{not:null}},select:{id:true,number:true,version:true,type:true,tableName:true,status:true,note:true,items:true,queuedAt:true,createdAt:true},orderBy:[{queuedAt:'asc'},{number:'asc'}],take:200}));}
 if(route==='orders'){
  await actor(request,['OWNER','CASHIER']);
  const page = readPage(url);
  const state = url.searchParams.get('status');
  const type = url.searchParams.get('type');
  const term = url.searchParams.get('q')?.trim();
  const orderNumber = term && /^\d+$/.test(term) ? Number(term) : null;
  const where = {
    ...(state && state !== 'ALL' ? { status: state } : {}),
    ...(type ? { type } : {}),
    ...(term ? { OR: [
      { customerName: { contains: term, mode: 'insensitive' as const } },
      { phone: { contains: term } },
      ...(orderNumber !== null && orderNumber <= 2_147_483_647 ? [{ number: orderNumber }] : []),
    ] } : {}),
  };
  const [orders,count] = await Promise.all([
    db.order.findMany({ where, include: orderInclude, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 30, take: 30 }),
    db.order.count({ where }),
  ]);
  return json({orders,count,page});
 }
 if(parts[0]==='orders'&&parts.length===2){await actor(request,['OWNER','CASHIER']);return json(await getOrder(parts[1]));}
 if(route==='manage/catalog'){await actor(request,['OWNER']);return json({categories:await db.category.findMany({orderBy:{sort:'asc'},include:{products:{orderBy:{sort:'asc'}}}}),coupons:await db.coupon.findMany({orderBy:{code:'asc'}})});}
 if(route==='manage/finances'){await actor(request,['OWNER']);const page=readPage(url);return json({purchaseCount:await db.purchase.count(),expenseCount:await db.expense.count(),ingredients:await db.ingredient.findMany({orderBy:{name:'asc'}}),purchases:await db.purchase.findMany({orderBy:{purchasedAt:'desc'},skip:(page-1)*100,take:100}),expenses:await db.expense.findMany({orderBy:{paidAt:'desc'},skip:(page-1)*100,take:100})});}
 if(route==='manage/settings'){await actor(request,['OWNER']);return json({shop:await db.shop.findUniqueOrThrow({where:{id:'main'}}),bankConfigured:bankConfigured()});}
 if(route==='manage/staff'){await actor(request,['OWNER']);return json(await db.user.findMany({select:{id:true,name:true,email:true,username:true,role:true,banned:true,createdAt:true},orderBy:{createdAt:'asc'}}));}
 if(route==='manage/reviews'){await actor(request,['OWNER']);return json(await db.bankEvent.findMany({where:{state:'REVIEW'},orderBy:{createdAt:'desc'},take:100}));}
 if(route==='reports'){await actor(request,['OWNER']);const group=z.enum(['day','month','year']).parse(url.searchParams.get('group')??'day');const data=await report(url.searchParams.get('from')??vnDay(),url.searchParams.get('to')??vnDay(),group);if(url.searchParams.get('format')==='csv')return new Response(reportCsv([...data.rows,data.total]),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="bao-cao.csv"','Cache-Control':'no-store'}});return json(data);}
 if(parts[0]==='payment-qr'&&parts.length===2){await publicLimit(request,'qr',120);const attempt=await db.paymentAttempt.findUnique({where:{id:parts[1]},include:{order:true}});ensure(attempt?.externalId,'Chưa có QR thanh toán.',404);if(url.searchParams.get('token'))ensure(attempt.order.token===url.searchParams.get('token'),'Không tìm thấy QR.',404);else await actor(request,['OWNER','CASHIER']);ensure(attempt.state==='PENDING'&&(!attempt.expiresAt||+attempt.expiresAt>Date.now())&&attempt.order.paymentStatus==='UNPAID','QR đã hết hiệu lực.',410);const image=await fetch(new URL('/qr/'+encodeURIComponent(attempt.externalId)+'.png',process.env.APIBANK_BASE_URL),{signal:AbortSignal.timeout(10000),redirect:'error'});ensure(image.ok&&image.headers.get('content-type')?.includes('image/png'),'Chưa tải được QR.',502);const bytes=await image.arrayBuffer();ensure(bytes.byteLength<1000000,'QR quá lớn.',502);return new Response(bytes,{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store'}});}
 throw new AppError(404,'Không tìm thấy chức năng.');
});}
export async function POST(request:Request,context:Context){return handler(async()=>{
 const parts=(await context.params).path;const route=parts.join('/');
 if(route==='payments/apibank/webhook'){
  const raw=Buffer.from(await readLimitedBody(request,128_000));ensure(verifyBankSignature(raw,request.headers.get('x-signature'),process.env.APIBANK_WEBHOOK_SECRET??''),'Chữ ký webhook không hợp lệ.',401);let event:unknown;try{event=JSON.parse(raw.toString('utf8'));}catch{throw new AppError(400,'Payload không hợp lệ.');}if(event&&typeof event==='object'&&'type' in event&&event.type==='webhook.test')return json({ok:true});await applyBankEvent(event);return json({ok:true});
 }
 sameOrigin(request);
 if(parts[0]==='table'&&parts.length===3&&parts[2]==='open'){await publicLimit(request,'table-open',60);return json(await openTable(parts[1]));}
 if(parts[0]==='table-visits'&&parts.length===3){
  if(parts[2]==='bill'){await publicLimit(request,'table-bill',20);return json(await requestTableBill(parts[1]));}
  const staff=await actor(request,['OWNER','CASHIER']);return json(await tableVisitAction(parts[1],parts[2],await body(request),staff));
 }
 if(parts[0]==='tables'){
  const staff=await actor(request,['OWNER']);const data=await body(request);
  if(parts.length===1||parts.length===2)return json(await saveTable(parts[1],data,staff),parts.length===1?201:200);
  if(parts.length===3&&parts[2]==='rotate')return json(await rotateTableQr(parts[1],data,staff));
 }
 if(route==='uploads'){
  await actor(request,['OWNER']);const raw=await readLimitedBody(request,6_000_000);const form=await new Request(request.url,{method:'POST',headers:{'Content-Type':request.headers.get('content-type')??''},body:new Blob([raw])}).formData();const file=form.get('file');ensure(file instanceof File&&file.size<=5_000_000,'Ảnh tối đa 5 MB.');const bytes=Buffer.from(await file.arrayBuffer());const img=sharp(bytes,{limitInputPixels:20000000});const metadata=await img.metadata();ensure(['jpeg','png','webp'].includes(metadata.format??''),'Chỉ hỗ trợ JPG, PNG hoặc WebP.');const name=crypto.randomUUID()+'.webp';const folder=path.resolve(/* turbopackIgnore: true */ process.env.UPLOAD_DIR??'uploads');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,name),await img.resize(1000,1000,{fit:'inside',withoutEnlargement:true}).rotate().webp({quality:82}).toBuffer());return json({url:'/uploads/'+name},201);
 }
 if(route==='orders'||route==='pos/orders'){const staff=route==='pos/orders'?await actor(request,['OWNER','CASHIER']):null;const input=orderInputSchema.parse(await body(request));if(!staff){await publicLimit(request,'create-order',60);if(input.tableVisitToken)await publicLimit(request,'table-order:'+input.tableVisitToken,20);}const order=await createOrder(input,staff);return json({id:order.id,number:order.number,token:order.token},201);}
 if(route==='quote'){await publicLimit(request,'quote',60);const input=orderInputSchema.parse(await body(request));const shop=await db.shop.findUniqueOrThrow({where:{id:'main'}});return json(await quote(input,shop.taxBps,0));}
 if(parts[0]==='track'&&parts[2]==='pay'){await publicLimit(request,'pay',20);const order=await track(parts[1]);const attempt=await beginPayment(order.id);return json({id:attempt.id,state:attempt.state});}
 if(parts[0]==='orders'&&parts.length===3){
  const action=parts[2];const staff=await actor(request,['start','ready'].includes(action)?['OWNER','CASHIER','KITCHEN']:['OWNER','CASHIER']);const data=await body(request);const version=z.number().int().min(0).parse(data.version);
  if(action==='confirm')return json(await confirmOrder(parts[1],version,staff,z.number().int().min(0).max(10000).parse(data.taxBps),z.number().int().min(0).max(1000000000).parse(data.shipping)));
  if(action==='edit')return json(await editOrder(parts[1],version,staff,orderInputSchema.parse(data.order)));
  if(action==='pay'){const order=await getOrder(parts[1]);ensure(order.version===version,'Đơn vừa cập nhật. Vui lòng tải lại.',409);return json(await beginPayment(order.id));}
  if(['cancel','reopen'].includes(action)){const current=await getOrder(parts[1]);ensure(current.version===version,'Đơn vừa cập nhật. Vui lòng tải lại.',409);if(current.paymentStatus==='PAID'||['PREPARING','READY'].includes(current.status))ensure(staff.role==='OWNER','Chỉ chủ quán được hủy đơn này.',403);await cancelActivePayments(parts[1]);}
  const result=await orderAction(parts[1],version,action,staff,z.string().max(1000).parse(data.note??''));return json(staff.role==='KITCHEN'?{ok:true}:result);
 }
 if(parts[0]==='deliveries'&&parts.length===2)return json(await saveDelivery(parts[1],await body(request),await actor(request,['OWNER','CASHIER'])));
 if(parts[0]==='manage'){
  const staff=await actor(request,['OWNER']);const data=await body(request);
  if(parts[1]==='purchases'&&parts[2])return json(await payPurchase(parts[2],data,staff));
  if(parts[1]==='purchases')return json(await createPurchase(data,staff),201);
  if(parts[1]==='expenses')return json(await createExpense(data,staff),201);
  if(parts[1]==='staff'){
   const values=z.object({name:z.string().min(1).max(120),username:z.string().regex(/^[a-zA-Z0-9._]{3,30}$/),email:z.email(),password:z.string().min(12).max(128),role:z.enum(['OWNER','CASHIER','KITCHEN'])}).parse(data);
   return json(await auth.api.createUser({headers:request.headers,body:{name:values.name,email:values.email,password:values.password,role:values.role,data:{username:values.username,displayUsername:values.username}}}),201);
  }
  if(parts[1]==='staff-action'){
   const values=z.object({userId:z.string(),action:z.enum(['ban','unban','password']),password:z.string().min(12).max(128).optional()}).parse(data);ensure(values.userId!==staff.id||values.action==='password','Không tự khóa tài khoản đang dùng.');
   if(values.action==='password'){ensure(values.password,'Nhập mật khẩu mới.');await auth.api.setUserPassword({headers:request.headers,body:{userId:values.userId,newPassword:values.password}});await auth.api.revokeUserSessions({headers:request.headers,body:{userId:values.userId}});}
   else if(values.action==='ban')await auth.api.banUser({headers:request.headers,body:{userId:values.userId,banReason:'Tạm khóa bởi chủ quán'}});else await auth.api.unbanUser({headers:request.headers,body:{userId:values.userId}});
   await db.audit.create({data:{actorId:staff.id,action:'STAFF_'+values.action,targetId:values.userId}});return json({ok:true});
  }
  if(parts[1]==='reviews'&&parts[2]){const {resolution}=z.object({resolution:z.string().min(5).max(1000)}).parse(data);const result=await db.bankEvent.updateMany({where:{id:parts[2],state:'REVIEW'},data:{state:'RESOLVED',resolution,resolvedAt:new Date(),resolvedBy:staff.id}});ensure(result.count,'Giao dịch đã được xử lý.',409);return json({ok:true});}
  if(parts[1]==='products'&&parts.length===4&&parts[3]==='availability')return json(await setProductAvailability(parts[2],data,staff));
  if(['products','categories','coupons','ingredients','settings'].includes(parts[1]))return json(await saveResource(parts[1],parts[2],data,staff));
 }
 throw new AppError(404,'Không tìm thấy chức năng.');
});}
