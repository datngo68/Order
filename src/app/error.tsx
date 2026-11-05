'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <main className="empty" style={{minHeight:'60dvh'}}><h1>Chưa tải được trang</h1><p>Dữ liệu của bạn vẫn được giữ. Hãy thử lại sau một lúc.</p><button className="btn primary" onClick={reset}>Thử lại</button></main>;}
