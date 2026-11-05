import { guard } from '@/lib/guard';
import { OrdersScreen } from '@/components/orders-screen';
export default async function Orders(){await guard(['OWNER','CASHIER']);return <OrdersScreen/>;}
