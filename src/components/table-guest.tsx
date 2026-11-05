'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect,useState,type ReactNode } from 'react';
import { ForkKnife,Bell,CheckCircle,ArrowRight,Receipt } from '@phosphor-icons/react';
import { Composer } from './composer';
import { useRemote,post,useTask,Loading,ErrorState,Badge,Empty } from './ui';
import type { Catalog,TableVisitView } from './types';
import { money,statusLabels } from '@/lib/format';

const tableVisitHref = (token: string) => '/t/visit/' + token;

export function TableBillButton({token,visit,onChange}:{token:string;visit:TableVisitView;onChange:()=>void}) {
  const task=useTask();
  const requested=!!visit.billRequestedAt;
  const hasOrders=visit.orders.some(order=>order.status!=='CANCELLED');
  return <div className="table-bill-box" aria-live="polite">
    {requested?<><CheckCircle size={23}/><div><strong>{visit.billAcknowledgedAt?'Nhân viên đã nhận yêu cầu':'Đã gọi nhân viên thanh toán'}</strong><p>{visit.billAcknowledgedAt?'Nhân viên sẽ hỗ trợ thanh toán tại bàn.':'Bạn chờ một chút nhé. Quán đã nhận được thông báo.'} Nếu muốn gọi thêm món, nhờ nhân viên mở lại.</p></div></>:<><Receipt size={23}/><div><strong>Thanh toán tại bàn</strong><p>Khi dùng bữa xong, gọi nhân viên mang hóa đơn đến bàn.</p></div><button className="btn primary" disabled={task.busy||!hasOrders||!!visit.closedAt||!visit.table.active} onClick={()=>task.run(async()=>{await post('/api/table-visits/'+token+'/bill',{});onChange();},'Đã gửi yêu cầu thanh toán cho nhân viên.')}><Bell size={18}/>{task.busy?'Đang gửi…':'Gọi thanh toán'}</button></>}
  </div>;
}

export function TableOrderActions({visitToken}:{visitToken:string}) {
  const remote=useRemote<TableVisitView>('/api/table-visits/'+visitToken,5000);
  if(!remote.data)return remote.error?<ErrorState message={remote.error} retry={remote.reload}/>:null;
  if(remote.data.closedAt)return <div className="note-box">Lượt phục vụ tại bàn đã kết thúc. Cảm ơn bạn!</div>;
  return <section className="table-tracking-actions"><Link className="btn full" href={tableVisitHref(visitToken)}>Xem bàn và gọi thêm món<ArrowRight size={17}/></Link><TableBillButton token={visitToken} visit={remote.data} onChange={remote.reload}/></section>;
}

function VisitMenu({token}:{token:string}) {
  const remote=useRemote<TableVisitView>('/api/table-visits/'+token,5000);
  const [showOrders,setShowOrders]=useState(false);
  const [lastOrder,setLastOrder]=useState<{number:number;token:string}|null>(null);
  const visit=remote.data;
  if(!visit)return remote.error?<ErrorState message={remote.error} retry={remote.reload}/>:<Loading/>;
  if(visit.closedAt||!visit.table.active)return <section className="panel"><Empty title="Lượt phục vụ đã kết thúc" description="Cảm ơn bạn đã ghé quán. Khi bắt đầu lượt mới, hãy quét lại QR tại bàn."/><Link href="/menu" className="btn full">Xem thực đơn</Link></section>;
  return <>
    <section className="table-guest-head"><div><Badge tone="orange">GỌI MÓN TẠI BÀN</Badge><h1>{visit.table.name}</h1><p>{visit.table.area||'Chọn món yêu thích. Quán sẽ phục vụ tại đúng bàn của bạn.'}</p></div><button className="btn" onClick={()=>setShowOrders(value=>!value)} aria-expanded={showOrders}><Receipt size={19}/>{visit.orders.length} lượt gọi · {money(visit.total)}</button></section>
    {remote.error&&<ErrorState message={remote.error} retry={remote.reload}/>}
    {lastOrder&&<div className="table-order-success" role="status"><CheckCircle size={21}/><span>Đã gửi order #{lastOrder.number}. Bạn có thể gọi thêm món.</span><Link href={'/track/'+lastOrder.token}>Theo dõi đơn →</Link></div>}
    {showOrders&&<section className="panel table-ordered"><div className="panel-head"><h2>Món đã gọi tại bàn</h2><Badge>{visit.orders.length} order</Badge></div>{!visit.orders.length?<Empty title="Bàn chưa gọi món" description="Chọn món bên dưới để gửi yêu cầu đến quán."/>:<div className="panel-body">{visit.orders.map(order=><article className="table-order-row" key={order.number}><div className="table-order-row-head"><strong>Order #{order.number}</strong><Badge>{statusLabels[order.status]}</Badge><span>{money(order.total)}</span></div>{order.items.map((item,i)=><p key={i}>{item.quantity} × {item.name}{item.options.length?' · '+item.options.join(', '):''}</p>)}<small className="muted">{statusLabels[order.paymentStatus]}</small></article>)}<div className="table-order-row-head"><strong>Còn cần thanh toán</strong><strong className="orange">{money(visit.unpaid)}</strong></div><p className="muted">Đơn chờ xác nhận là giá tạm tính. Nhân viên sẽ chốt hóa đơn trước khi nhận tiền.</p></div>}</section>}
    <TableBillButton token={token} visit={visit} onChange={remote.reload}/>
    {!visit.billRequestedAt&&<Composer tableContext={{token,name:visit.table.name}} onCreated={created=>{setLastOrder(created);remote.reload();window.scrollTo({top:0,behavior:'smooth'});}}/>}
  </>;
}

function TableGuestLayout({ children }: { children: ReactNode }) {
  const shop=useRemote<Catalog>('/api/catalog');
  const name = shop.data?.shop.name ?? 'Quán Nhà';
  const phone = shop.data?.shop.phone;
  return <div className="public-page table-guest-page">
    <header className="public-header">
      <Link href="/menu" className="brand"><span className="brand-mark"><ForkKnife size={25}/></span><span>{name}</span></Link>
      {phone && <a className="text-link" href={'tel:'+phone}>Liên hệ quán</a>}
    </header>
    <main className="public-container">{children}</main>
    <footer className="public-footer">Gọi món tại bàn · {name}</footer>
  </div>;
}

export function TableVisitGuest({ token }: { token: string }) {
  return <TableGuestLayout><VisitMenu key={token} token={token}/></TableGuestLayout>;
}

export function TableGuest({qrToken}:{qrToken:string}) {
  const router = useRouter();
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  useEffect(() => {
    let alive = true;
    setError('');
    post<{ token: string }>('/api/table/' + qrToken + '/open', {}).then(({ token }) => {
      if (alive) router.replace(tableVisitHref(token));
    }).catch(error => {
      if (alive) setError(error instanceof Error ? error.message : 'Chưa mở được bàn.');
    });
    return () => { alive = false; };
  }, [qrToken, revision, router]);
  return <TableGuestLayout>{error?<ErrorState message={error} retry={()=>setRevision(value=>value+1)}/>:<Loading/>}</TableGuestLayout>;
}
