import { db } from './db';
import { reportRange } from './domain';
import { vnDay } from './format';
export type ReportRow={period:string;orders:number;subtotal:number;discount:number;tax:number;shipping:number;received:number;refunds:number;ingredients:number;otherExpenses:number;net:number};
export async function report(from:string,to:string,group='day'){
 const {start,end}=reportRange(from,to);const [records,expenses]=await Promise.all([db.paymentRecord.findMany({where:{paidAt:{gte:start,lt:end}},orderBy:{paidAt:'asc'}}),db.expense.findMany({where:{paidAt:{gte:start,lt:end}},orderBy:{paidAt:'asc'}})]);
 const rows=new Map<string,ReportRow>();const create=(period:string):ReportRow=>({period,orders:0,subtotal:0,discount:0,tax:0,shipping:0,received:0,refunds:0,ingredients:0,otherExpenses:0,net:0});const get=(date:Date)=>{const day=vnDay(date);const key=group==='year'?day.slice(0,4):group==='month'?day.slice(0,7):day;if(!rows.has(key))rows.set(key,create(key));return rows.get(key)!;};
 for(const rec of records){const row=get(rec.paidAt);if(rec.kind==='RECEIPT'){row.orders++;row.subtotal+=rec.subtotal;row.discount+=rec.discount;row.tax+=rec.tax;row.shipping+=rec.shipping;row.received+=rec.amount;}else row.refunds+=rec.amount;}
 for(const expense of expenses){const row=get(expense.paidAt);if(expense.category==='INGREDIENT')row.ingredients+=expense.amount;else row.otherExpenses+=expense.amount;}
 const ordered=[...rows.values()].sort((a,b)=>a.period.localeCompare(b.period));for(const r of ordered)r.net=r.received-r.refunds-r.ingredients-r.otherExpenses;const total=create('Tổng cộng');for(const row of ordered)for(const key of Object.keys(total) as (keyof ReportRow)[])if(key!=='period')total[key]+=row[key];return {from,to,group,rows:ordered,total};
}
export function reportCsv(rows:ReportRow[]){const headers=['Kỳ','Đơn đã thu','Tiền món','Giảm giá','Thuế','Phí ship','Thực thu','Hoàn tiền','Chi nguyên liệu','Chi khác','Chênh lệch'];const esc=(v:unknown)=>'"'+String(v).replaceAll('"','""')+'"';return '\ufeff'+[headers,...rows.map(r=>[r.period,r.orders,r.subtotal,r.discount,r.tax,r.shipping,r.received,r.refunds,r.ingredients,r.otherExpenses,r.net])].map(row=>row.map(esc).join(',')).join('\r\n');}
