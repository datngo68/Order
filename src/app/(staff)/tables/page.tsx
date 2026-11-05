import { guard } from '@/lib/guard';
import { TablesScreen } from '@/components/tables-screen';
export default async function Page(){await guard(['OWNER','CASHIER']);return <TablesScreen/>;}
