'use client';
import Link from 'next/link';
import { useState } from 'react';
import { QrCode,Plus,Printer,PencilSimple,Bell,CheckCircle,ArrowClockwise,Users,Copy,DownloadSimple } from '@phosphor-icons/react';
import { useRemote,useTask,post,PageHead,Modal,Field,Badge,ErrorState,Loading,Empty } from './ui';
import { useStaff } from './shell';
import { OrderDetail,statusTone } from './order-detail';
import type { DiningTableView } from './types';
import { money,dateTime,statusLabels } from '@/lib/format';

function TableEditor({table,onClose,onSaved}:{table?:DiningTableView;onClose:()=>void;onSaved:()=>void}) {
  const [form,setForm]=useState({name:table?.name??'',area:table?.area??'',seats:table?.seats??4,active:table?.active??true});
  const task=useTask();
  return <Modal open onClose={onClose} title={table?'Chỉnh sửa '+table.name:'Thêm bàn mới'} description="Mỗi bàn có một mã QR riêng để khách gọi món và gọi thanh toán."><form className="form-stack" onSubmit={event=>{event.preventDefault();task.run(async()=>{await post('/api/tables'+(table?'/'+table.id:''),{...form,version:table?.version});onSaved();onClose();},'Đã lưu bàn.');}}><Field label="Tên bàn"><input autoFocus required maxLength={30} value={form.name} onChange={event=>setForm({...form,name:event.target.value})} placeholder="Ví dụ: Bàn 01"/></Field><div className="form-grid"><Field label="Khu vực"><input maxLength={80} value={form.area} onChange={event=>setForm({...form,area:event.target.value})} placeholder="Ví dụ: Tầng trệt"/></Field><Field label="Số chỗ ngồi"><input type="number" min={1} max={30} required value={form.seats} onChange={event=>setForm({...form,seats:Number(event.target.value)})}/></Field></div><label className="check-label"><input type="checkbox" checked={form.active} onChange={event=>setForm({...form,active:event.target.checked})}/>Đang phục vụ</label><button className="btn primary full" disabled={task.busy}>{task.busy?'Đang lưu…':'Lưu bàn'}</button></form></Modal>;
}

function TableQr({table,onClose}:{table:DiningTableView;onClose:()=>void}) {
  const task=useTask();
  const local=['localhost','127.0.0.1','[::1]'].includes(new URL(table.qrUrl).hostname);
  return <Modal open onClose={onClose} title={'QR · '+table.name} description="In mã này và đặt ở nơi khách dễ quét."><div className="table-qr-preview"><img src={'/api/tables/'+table.id+'/qr?v='+table.version} width={260} height={260} alt={'QR gọi món tại '+table.name}/><h2>{table.name}</h2><p>Quét mã · Gọi món · Gọi thanh toán</p></div>{local&&<div className="note-box">QR hiện dùng địa chỉ trên máy phát triển. Cần cấu hình tên miền website của quán trước khi in để điện thoại khách truy cập được.</div>}<Field label="Đường dẫn QR"><input readOnly value={table.qrUrl} onFocus={event=>event.target.select()}/></Field><div className="table-card-actions"><button className="btn" onClick={()=>task.run(async()=>{await navigator.clipboard.writeText(table.qrUrl);},'Đã sao chép đường dẫn.')}><Copy size={17}/>Sao chép</button><a className="btn" href={'/api/tables/'+table.id+'/qr?download=1'}><DownloadSimple size={17}/>Tải QR SVG</a><Link className="btn primary" target="_blank" href={'/tables/print?id='+table.id}><Printer size={17}/>In thẻ bàn</Link><Link className="btn ghost" target="_blank" href={table.qrUrl}>Mở trang khách ↗</Link></div></Modal>;
}

export function TablesScreen() {
  const remote=useRemote<DiningTableView[]>('/api/tables',5000);
  const staff=useStaff();const owner=staff.role==='OWNER';const task=useTask();
  const [editor,setEditor]=useState<DiningTableView|'new'|null>(null);
  const [qr,setQr]=useState<DiningTableView|null>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [filter,setFilter]=useState('all');
  const [confirm,setConfirm]=useState<{table:DiningTableView;action:'close'|'rotate'}|null>(null);
  const tables=remote.data??[];
  const requested=tables.filter(table=>table.visit?.billRequestedAt);
  const shown=tables.filter(table=>filter==='all'||filter==='occupied'&&table.visit||filter==='bill'&&table.visit?.billRequestedAt||filter==='available'&&table.active&&!table.visit);
  async function visitAction(table:DiningTableView,action:string) {
    await task.run(async()=>{await post('/api/table-visits/'+table.visit!.id+'/'+action,{version:table.visit!.version});remote.reload();},action==='acknowledge'?'Đã nhận yêu cầu thanh toán.':'Đã mở lại gọi món cho bàn.');
  }
  return <>
    <PageHead eyebrow="PHỤC VỤ TẠI BÀN" title="Bàn & QR" description="Một mã QR cho mỗi bàn. Nhận món mới và hỗ trợ khách thanh toán ngay tại chỗ."><Link className="btn" href="/tables/print" target="_blank"><Printer size={18}/>In QR các bàn</Link>{owner&&<button className="btn primary" onClick={()=>setEditor('new')}><Plus size={18}/>Thêm bàn</button>}</PageHead>
    {remote.error&&<ErrorState message={remote.error} retry={remote.reload}/>}
    <div className="table-summary"><div><span>Bàn đang phục vụ</span><strong>{tables.filter(table=>table.active).length}</strong></div><div><span>Đang có khách</span><strong>{tables.filter(table=>table.visit).length}</strong></div><div className={requested.length?'has-request':''}><span>Gọi thanh toán</span><strong>{requested.length}</strong></div></div>
    <div className="tabs table-filter" aria-label="Lọc bàn">{[['all','Tất cả bàn'],['available','Bàn trống'],['occupied','Đang có khách'],['bill','Gọi thanh toán']].map(([value,label])=><button className={'tab '+(filter===value?'active':'')} aria-pressed={filter===value} key={value} onClick={()=>setFilter(value)}>{label}</button>)}</div>
    {remote.loading?<Loading/>:!shown.length?<section className="panel"><Empty title={tables.length?'Không có bàn trong nhóm này':'Thêm bàn đầu tiên của quán'} description={tables.length?'Chọn nhóm khác để xem các bàn.':'Đặt tên bàn, tải mã QR rồi in dán lên bàn để khách bắt đầu gọi món.'}/></section>:<div className="dining-table-grid">{shown.map(table=>{
      const visit=table.visit;const total=visit?.orders.filter(order=>order.status!=='CANCELLED').reduce((sum,order)=>sum+order.total,0)??0;
      const unpaid=visit?.orders.filter(order=>order.status!=='CANCELLED'&&order.paymentStatus==='UNPAID').reduce((sum,order)=>sum+order.total,0)??0;
      const canClose=visit?.orders.every(order=>order.status==='CANCELLED'?order.paymentStatus!=='PAID':order.status==='COMPLETED'&&order.paymentStatus==='PAID');
      return <article className={'dining-table-card '+(visit?.billRequestedAt?'bill-requested':'')} key={table.id}><header><div><small>{table.area||'Khu vực chung'}</small><h2>{table.name}</h2></div><Badge tone={!table.active?'neutral':visit?.billRequestedAt?'orange':visit?'blue':'green'}>{!table.active?'Tạm ngưng':visit?.billRequestedAt?'Gọi thanh toán':visit?'Đang có khách':'Bàn trống'}</Badge></header><p className="table-seats"><Users size={16}/>{table.seats} chỗ{visit&&<span>· Từ {dateTime(visit.openedAt)}</span>}</p>
      {visit?.billRequestedAt&&<div className="table-request" role="status"><Bell size={20}/><div><strong>{visit.billAcknowledgedAt?'Đã nhận yêu cầu':'Khách đang chờ thanh toán'}</strong><small>{dateTime(visit.billRequestedAt)}</small></div>{!visit.billAcknowledgedAt&&<button className="btn small primary" disabled={task.busy} onClick={()=>visitAction(table,'acknowledge')}>Tiếp nhận</button>}</div>}
      {visit?<><div className="table-visit-total"><div><small>Tổng tiền món & thuế</small><strong>{money(total)}</strong></div><div><small>Chưa thu</small><strong className="orange">{money(unpaid)}</strong></div></div><div className="table-order-links">{visit.orders.length?visit.orders.map(order=><button className="table-order-link" key={order.id} onClick={()=>setSelected(order.id)}><strong>#{order.number}</strong><span>{statusLabels[order.status]}</span><Badge tone={statusTone(order.paymentStatus)}>{statusLabels[order.paymentStatus]}</Badge></button>):<p className="muted">Khách đã quét QR, chưa gửi món.</p>}</div><div className="table-card-actions">{visit.orders.length>0&&<Link className="btn small" href={{pathname:'/tables/'+table.id+'/bill',query:{visit:visit.id}}} target="_blank"><Printer size={16}/>In hóa đơn bàn</Link>}{visit.billRequestedAt&&<button className="btn small" disabled={task.busy} onClick={()=>visitAction(table,'resume')}><ArrowClockwise size={16}/>Cho gọi thêm món</button>}<button className="btn small" disabled={!canClose||task.busy} title={canClose?'Dọn bàn cho lượt khách tiếp theo':'Hoàn tất món và ghi nhận thanh toán trong từng order trước'} onClick={()=>setConfirm({table,action:'close'})}><CheckCircle size={16}/>Kết thúc lượt khách</button></div></>:<p className="table-empty-note">{table.active?'Sẵn sàng đón khách. Quét QR để bắt đầu gọi món.':'Bật lại bàn khi sẵn sàng phục vụ.'}</p>}
      <footer className="table-card-actions"><button className="btn small" onClick={()=>setQr(table)}><QrCode size={17}/>QR bàn</button>{owner&&<><button className="btn small ghost" onClick={()=>setEditor(table)}><PencilSimple size={16}/>Sửa bàn</button><button className="btn small ghost" disabled={!!visit} onClick={()=>setConfirm({table,action:'rotate'})}>Đổi mã QR</button></>}</footer></article>;
    })}</div>}
    {editor&&<TableEditor table={editor==='new'?undefined:editor} onClose={()=>setEditor(null)} onSaved={remote.reload}/>}
    {qr&&<TableQr table={qr} onClose={()=>setQr(null)}/>}
    {selected&&<OrderDetail id={selected} onClose={()=>setSelected(null)} onChange={remote.reload}/>}
    {confirm&&<Modal open onClose={()=>setConfirm(null)} title={(confirm.action==='close'?'Kết thúc lượt khách · ':'Đổi QR · ')+confirm.table.name} description={confirm.action==='close'?'Lượt này sẽ được đóng. Khách tiếp theo quét QR sẽ bắt đầu lượt mới.':'Mã QR cũ sẽ ngừng hoạt động. Bạn cần in và thay mã QR mới trên bàn.'}><button className="btn primary full" disabled={task.busy} onClick={()=>task.run(async()=>{if(confirm.action==='close')await post('/api/table-visits/'+confirm.table.visit!.id+'/close',{version:confirm.table.visit!.version});else await post('/api/tables/'+confirm.table.id+'/rotate',{version:confirm.table.version});setConfirm(null);remote.reload();},confirm.action==='close'?'Đã kết thúc lượt khách.':'Đã đổi QR. Hãy in mã mới để thay trên bàn.')}>{task.busy?'Đang xử lý…':confirm.action==='close'?'Xác nhận kết thúc':'Đổi và vô hiệu mã cũ'}</button></Modal>}
  </>;
}
