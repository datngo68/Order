import { guard } from '@/lib/guard';
import { CouponsAdmin } from '@/components/catalog-admin';
export default async function Page(){await guard(['OWNER']);return <CouponsAdmin/>;}
