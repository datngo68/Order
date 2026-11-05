import { guard } from '@/lib/guard';
import { MenuAdmin } from '@/components/catalog-admin';
export default async function Page(){await guard(['OWNER']);return <MenuAdmin/>;}
