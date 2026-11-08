import { auth, type Actor } from './auth';
import { db } from './db';
import { AppError, ensure } from './errors';
import { ZodError } from 'zod';
import { createHash } from 'node:crypto';
import { readLimitedBody } from './request-body';
import { rateLimitIp } from './request-ip';
export async function actor(request:Request,roles=['OWNER','CASHIER','KITCHEN']):Promise<Actor>{const session=await auth.api.getSession({headers:request.headers});ensure(session,'Vui lòng đăng nhập.',401);const role=session.user.role??'';ensure(roles.includes(role),'Bạn không có quyền thực hiện thao tác này.',403);return {id:session.user.id,name:session.user.name,role};}
export function sameOrigin(request:Request){const origin=request.headers.get('origin');const expected=new URL(process.env.APP_URL??request.url).origin;ensure(origin===expected,'Yêu cầu không hợp lệ.',403);}
export async function body(request:Request){const text=new TextDecoder().decode(await readLimitedBody(request,128_000));try{return JSON.parse(text);}catch{throw new AppError(400,'Dữ liệu JSON không hợp lệ.');}}
export function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store'}});}
export async function handler(fn:()=>Promise<Response>){try{return await fn();}catch(e){if(e instanceof AppError)return json({error:e.message},e.status);if(e instanceof ZodError)return json({error:e.issues.map(x=>x.message).join(' ')},400);if(e&&typeof e==='object'&&'code' in e&&e.code==='P2002')return json({error:'Dữ liệu đã tồn tại. Vui lòng tải lại.'},409);console.error('[request-error]',e instanceof Error?e.message:'unknown');return json({error:'Không thể xử lý lúc này. Vui lòng thử lại.'},500);}}
export async function publicLimit(request:Request,name:string,max=20){return requestLimit(name,rateLimitIp(request.headers),max);}
export async function requestLimit(name:string,identity:string,max:number){const hash=createHash('sha256').update(identity).digest('hex').slice(0,24);const bucket=Math.floor(Date.now()/60000);const entry=await db.requestLimit.upsert({where:{key:name+':'+hash+':'+bucket},create:{key:name+':'+hash+':'+bucket,expiresAt:new Date(Date.now()+120000)},update:{count:{increment:1}}});ensure(entry.count<=max,'Bạn thao tác quá nhanh. Vui lòng đợi một phút.',429);}
