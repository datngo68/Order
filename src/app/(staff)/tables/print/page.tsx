import QRCode from 'qrcode';
import { guard } from '@/lib/guard';
import { db } from '@/lib/db';
import { tableQrUrl } from '@/lib/tables';
import { TableQrPrint } from '@/components/table-print';
export default async function Page({searchParams}:{searchParams:Promise<{id?:string}>}) {
  await guard(['OWNER','CASHIER']);const {id}=await searchParams;
  const [shop,tables]=await Promise.all([db.shop.findUniqueOrThrow({where:{id:'main'}}),db.diningTable.findMany({where:{...(id?{id}:{active:true})},orderBy:[{area:'asc'},{name:'asc'}]})]);
  const cards=await Promise.all(tables.map(async table=>{const url=tableQrUrl(table.qrToken);return {name:table.name,area:table.area,url,image:await QRCode.toDataURL(url,{errorCorrectionLevel:'M',margin:4,width:640})};}));
  return <TableQrPrint shopName={shop.name} cards={cards}/>;
}
