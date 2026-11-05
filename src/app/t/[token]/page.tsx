import { TableGuest } from '@/components/table-guest';
export default async function Page({params}:{params:Promise<{token:string}>}) {
  return <TableGuest qrToken={(await params).token}/>;
}
