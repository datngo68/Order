import { z } from 'zod';
import Decimal from 'decimal.js';
import { ensure } from './errors';
export const moneySchema=z.number().int().min(0).max(1_000_000_000);
export const optionGroupsSchema=z.array(z.object({id:z.string().min(1),name:z.string().min(1).max(80),min:z.number().int().min(0).max(20),max:z.number().int().min(1).max(20),options:z.array(z.object({id:z.string().min(1),name:z.string().min(1).max(80),price:moneySchema})).min(1).max(30)})).max(12).superRefine((groups,ctx)=>{
 const ids=new Set<string>(); for(const g of groups){if(g.min>g.max||g.max>g.options.length)ctx.addIssue({code:'custom',message:'Giới hạn lựa chọn không hợp lệ.'});for(const id of [g.id,...g.options.map(o=>o.id)]){if(ids.has(id))ctx.addIssue({code:'custom',message:'Mã nhóm/option phải duy nhất.'});ids.add(id);}}
});
export type OptionGroup=z.infer<typeof optionGroupsSchema>;
export const cartLineSchema=z.object({productId:z.string().min(1),quantity:z.number().int().min(1).max(99),selected:z.array(z.string()).max(100).default([]),note:z.string().max(500).default('')});
export const orderInputSchema=z.object({key:z.string().uuid(),type:z.enum(['DINE_IN','TAKEAWAY','DELIVERY']),paymentMethod:z.enum(['CASH','COD','TRANSFER']),customerName:z.string().max(120).default(''),phone:z.string().max(30).default(''),address:z.string().max(500).default(''),tableName:z.string().max(30).default(''),tableVisitToken:z.string().regex(/^[A-Za-z0-9_-]{32}$/).optional(),note:z.string().max(1000).default(''),couponCode:z.string().max(40).default(''),items:z.array(cartLineSchema).min(1).max(60)}).superRefine((data,ctx)=>{
 if(data.type==='DELIVERY'&&(!data.customerName.trim()||!data.address.trim()||!/^\+?[\d\s().-]{7,20}$/.test(data.phone)))ctx.addIssue({code:'custom',message:'Đơn giao hàng cần tên, điện thoại hợp lệ và địa chỉ.'});
 if(data.type==='DINE_IN'&&!data.tableName.trim()&&!data.tableVisitToken)ctx.addIssue({code:'custom',message:'Vui lòng nhập số bàn.'});
 if(data.tableVisitToken&&data.type!=='DINE_IN')ctx.addIssue({code:'custom',message:'QR bàn chỉ dùng để gọi món tại bàn.'});
 if(data.paymentMethod==='COD'&&data.type!=='DELIVERY')ctx.addIssue({code:'custom',message:'COD chỉ dùng cho đơn giao hàng.'});
});
export type OrderInput=z.infer<typeof orderInputSchema>;
export type CartLine=z.infer<typeof cartLineSchema>;
export type SnapshotLine={productId:string;name:string;basePrice:number;quantity:number;note:string;options:{id:string;name:string;price:number}[];unitPrice:number;total:number};
export type MenuProduct={id:string;name:string;price:number;available:boolean;active:boolean;optionGroups:unknown};
export type DiscountCoupon={code:string;type:string;value:number;minSubtotal:number;maxDiscount:number|null;startsAt:Date|null;expiresAt:Date|null;active:boolean};
export function buildItems(lines:CartLine[],products:MenuProduct[]):SnapshotLine[]{
 return lines.map(line=>{const p=products.find(p=>p.id===line.productId);ensure(p&&p.available&&p.active,'Món đã hết hoặc không còn bán. Vui lòng chọn lại.');const groups=optionGroupsSchema.parse(p.optionGroups);const selected=new Set(line.selected);ensure(selected.size===line.selected.length,'Không được chọn trùng option.');const all=groups.flatMap(g=>g.options);ensure([...selected].every(id=>all.some(o=>o.id===id)),'Option không thuộc món.');for(const g of groups){const n=g.options.filter(o=>selected.has(o.id)).length;ensure(n>=g.min&&n<=g.max,'Chọn từ '+g.min+' đến '+g.max+' lựa chọn cho '+g.name+'.');}const options=all.filter(o=>selected.has(o.id));const unitPrice=p.price+options.reduce((s,o)=>s+o.price,0);const total=unitPrice*line.quantity;ensure(total<=1_000_000_000,'Giá trị món vượt giới hạn.');return {productId:p.id,name:p.name,basePrice:p.price,quantity:line.quantity,note:line.note,options,unitPrice,total};});
}
export function calculateTotals(items:SnapshotLine[],coupon:DiscountCoupon|null,taxBps:number,shipping:number,now=new Date()){
 ensure(Number.isInteger(taxBps)&&taxBps>=0&&taxBps<=10000,'Thuế không hợp lệ.');moneySchema.parse(shipping);
 const subtotal=items.reduce((sum,i)=>sum+i.total,0);ensure(subtotal<=1_000_000_000,'Giá trị đơn vượt giới hạn.');let discount=0;
 if(coupon){ensure(coupon.active&&(!coupon.startsAt||coupon.startsAt<=now)&&(!coupon.expiresAt||coupon.expiresAt>now),'Mã giảm giá chưa có hiệu lực hoặc đã hết hạn.');ensure(subtotal>=coupon.minSubtotal,'Đơn chưa đạt giá trị tối thiểu của mã giảm giá.');discount=coupon.type==='PERCENT'?new Decimal(subtotal).mul(coupon.value).div(100).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber():coupon.value;if(coupon.maxDiscount!==null)discount=Math.min(discount,coupon.maxDiscount);discount=Math.min(discount,subtotal);}
 const tax=new Decimal(subtotal-discount).mul(taxBps).div(10000).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber();const total=subtotal-discount+tax+shipping;ensure(Number.isSafeInteger(total)&&total<=2_000_000_000,'Tổng tiền vượt giới hạn.');return {subtotal,discount,taxBps,tax,shipping,total};
}
export function reportRange(from:string,to:string){
 ensure(/^\d{4}-\d{2}-\d{2}$/.test(from)&&/^\d{4}-\d{2}-\d{2}$/.test(to),'Khoảng ngày không hợp lệ.');const start=new Date(from+'T00:00:00+07:00');const end=new Date(new Date(to+'T00:00:00+07:00').getTime()+86400000);ensure(Number.isFinite(+start)&&Number.isFinite(+end)&&start<end&&+end-+start<=3660*86400000,'Khoảng ngày không hợp lệ.');return {start,end};
}
