import { guard } from '@/lib/guard';
import { Shell } from '@/components/shell';
export const dynamic='force-dynamic';
export default async function StaffLayout({children}:{children:React.ReactNode}){return <Shell staff={await guard()}>{children}</Shell>;}
