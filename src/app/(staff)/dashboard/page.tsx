import { guard } from '@/lib/guard';
import { DashboardScreen } from '@/components/reports-screen';
export default async function Dashboard(){await guard(['OWNER']);return <DashboardScreen/>;}
