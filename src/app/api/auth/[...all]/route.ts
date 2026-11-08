import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';
import { rateLimitIp } from '@/lib/request-ip';
import { readLimitedBody } from '@/lib/request-body';
import { AppError } from '@/lib/errors';
const handlers=toNextJsHandler(auth);
const notFound=()=>Response.json({error:'Không tìm thấy chức năng.'},{status:404});
function blocked(request:Request){let pathname:string;try{pathname=decodeURIComponent(new URL(request.url).pathname);}catch{return true;}return pathname==='/api/auth/admin'||pathname.startsWith('/api/auth/admin/');}
// Build a plain Request: cloning Next's request object with `new Request(request, init)` throws in production builds.
async function authRequest(request:Request){
 const headers=new Headers(request.headers);headers.delete('x-forwarded-for');if(process.env.TRUST_PROXY!=='0'){const ip=rateLimitIp(request.headers);if(ip!=='unknown')headers.set('x-forwarded-for',ip);}
 const hasBody=request.method!=='GET'&&request.method!=='HEAD';
 return new Request(request.url,{method:request.method,headers,body:hasBody?Buffer.from(await readLimitedBody(request,128_000)):undefined});
}
async function run(request:Request,handle:(request:Request)=>Promise<Response>){
 if(blocked(request))return notFound();
 try{return await handle(await authRequest(request));}catch(e){if(e instanceof AppError)return Response.json({error:e.message},{status:e.status});throw e;}
}
export async function GET(request:Request){return run(request,handlers.GET);}
export async function POST(request:Request){return run(request,handlers.POST);}
