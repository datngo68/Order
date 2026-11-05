import { guard } from '@/lib/guard';
import { FinancesScreen } from '@/components/finances-screen';
export default async function Page(){await guard(['OWNER']);return <FinancesScreen/>;}
