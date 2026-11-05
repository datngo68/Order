import { guard } from '@/lib/guard';
import { getOrder } from '@/lib/orders';
import { db } from '@/lib/db';
import { Receipt } from '@/components/receipt';
export const dynamic='force-dynamic';
export default async function ReceiptPage({params}:{params:Promise<{id:string}>}){await guard(['OWNER','CASHIER']);const order=await getOrder((await params).id);const shop=await db.shop.findUniqueOrThrow({where:{id:'main'}});return <Receipt order={JSON.parse(JSON.stringify(order))} shop={JSON.parse(JSON.stringify(shop))}/>;}
