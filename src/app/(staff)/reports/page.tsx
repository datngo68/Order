import { guard } from '@/lib/guard';
import { ReportsScreen } from '@/components/reports-screen';
export default async function Reports(){await guard(['OWNER']);return <ReportsScreen/>;}
