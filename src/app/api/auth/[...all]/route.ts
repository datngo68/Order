import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';
import { rateLimitIp } from '@/lib/request-ip';
const handlers=toNextJsHandler(auth);
function authRequest(request:Request){
 const pathname=decodeURIComponent(new URL(request.url).pathname);if(pathname==='/api/auth/admin'||pathname.startsWith('/api/auth/admin/'))return null;
 const headers=new Headers(request.headers);headers.delete('x-forwarded-for');if(process.env.TRUST_PROXY!=='0'){const ip=rateLimitIp(request.headers);if(ip!=='unknown')headers.set('x-forwarded-for',ip);}return new Request(request,{headers});
}
export async function GET(request:Request){const safe=authRequest(request);return safe?handlers.GET(safe):Response.json({error:'Không tìm thấy chức năng.'},{status:404});}
export async function POST(request:Request){const safe=authRequest(request);return safe?handlers.POST(safe):Response.json({error:'Không tìm thấy chức năng.'},{status:404});}
