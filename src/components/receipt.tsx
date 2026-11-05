'use client';
import { Printer } from '@phosphor-icons/react';
import { Totals } from './composer';
import { ItemLines } from './order-detail';
import { dateTime,statusLabels } from '@/lib/format';
import type { SnapshotLine } from '@/lib/domain';
import type { OrderView,Catalog } from './types';
export function Receipt({order,shop}:{order:OrderView;shop:Catalog['shop']}){return <main className="receipt-print"><button className="btn primary full no-print" style={{marginBottom:25}} onClick={()=>window.print()}><Printer size={18}/>In phiếu tính tiền</button><h1>{shop.name}</h1><p>{shop.address}</p><p>{shop.phone}</p><div className="receipt-heading"><h2 style={{textAlign:'center',fontSize:16}}>PHIẾU TÍNH TIỀN</h2><p>Order #{String(order.number).padStart(4,'0')} · {statusLabels[order.type]}</p><p>{dateTime(order.createdAt)}</p>{order.tableName&&<p>{order.tableName}</p>}</div><ItemLines items={order.items as unknown as SnapshotLine[]}/><Totals {...order}/><p style={{marginTop:15}}>{statusLabels[order.paymentStatus]} · {statusLabels[order.paymentMethod]}</p><footer>Cảm ơn quý khách. Hẹn gặp lại!<br/>Phiếu tính tiền nội bộ, không thay thế hóa đơn điện tử.</footer></main>;}
