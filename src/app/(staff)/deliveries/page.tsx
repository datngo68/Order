import { guard } from '@/lib/guard';
import { DeliveriesScreen } from '@/components/deliveries-screen';
export default async function Deliveries(){await guard(['OWNER','CASHIER']);return <DeliveriesScreen/>;}
