import { Composer } from '@/components/composer';
import { PageHead } from '@/components/ui';
import { guard } from '@/lib/guard';
export default async function Pos(){await guard(['OWNER','CASHIER']);return <><PageHead eyebrow="NHẬN ORDER" title="Hôm nay, khách dùng gì?" description="Chọn món, thêm lựa chọn và gửi order đến quán."/><Composer staff/></>;}
