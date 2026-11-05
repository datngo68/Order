import { guard } from '@/lib/guard';
import { StaffScreen } from '@/components/settings-screens';
export default async function Page(){await guard(['OWNER']);return <StaffScreen/>;}
