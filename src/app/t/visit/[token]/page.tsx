import { notFound } from 'next/navigation';
import { TableVisitGuest } from '@/components/table-guest';

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) notFound();
  return <TableVisitGuest token={token}/>;
}
