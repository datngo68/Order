import type { Metadata } from 'next';
import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/be-vietnam-pro/700.css';
import './globals.css';
import { Providers } from '@/components/ui';
export const metadata:Metadata={title:{default:'Quán Nhà | Order & vận hành',template:'%s | Quán Nhà'},description:'Đặt món, theo dõi chế biến và quản lý quán trên một không gian.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="vi"><body><Providers>{children}</Providers></body></html>;}
