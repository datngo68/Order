import { guard } from '@/lib/guard';
import { ReviewsScreen } from '@/components/settings-screens';
export default async function Page(){await guard(['OWNER']);return <ReviewsScreen/>;}
