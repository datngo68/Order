import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { guard } from '@/lib/guard';
import { getTableBillVisit } from '@/lib/tables';
import { TableReceipt } from '@/components/table-receipt';
import type { SnapshotLine } from '@/lib/domain';
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ visit?: string | string[] }>;
}) {
  await guard(['OWNER','CASHIER']);
  const { id } = await params;
  const { visit: visitId } = await searchParams;
  if (Array.isArray(visitId) || visitId === '') notFound();
  const [shop, visit] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: 'main' } }),
    getTableBillVisit(id, visitId),
  ]);
  if(!visit)notFound();
  return <TableReceipt shop={{name:shop.name,address:shop.address,phone:shop.phone}} tableName={visit.table.name} openedAt={visit.openedAt.toISOString()} orders={visit.orders.map(order=>({number:order.number,status:order.status,paymentStatus:order.paymentStatus,items:order.items as unknown as SnapshotLine[],subtotal:order.subtotal,discount:order.discount,tax:order.tax,total:order.total}))}/>;
}
