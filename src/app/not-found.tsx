import Link from 'next/link';
export default function NotFound(){return <main className="empty" style={{minHeight:'80dvh'}}><h1>Không tìm thấy trang</h1><p>Đường dẫn này không tồn tại hoặc đã thay đổi.</p><Link href="/menu" className="btn primary">Về menu của quán</Link></main>;}
