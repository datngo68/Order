import { guard } from '@/lib/guard';
import { SettingsScreen } from '@/components/settings-screens';
export default async function Page(){await guard(['OWNER']);return <SettingsScreen/>;}
