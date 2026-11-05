import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { db } from '../src/lib/db';
import { auth } from '../src/lib/auth';
async function main(){const username=process.env.OWNER_USERNAME??'chuquan';if(await db.user.findFirst({where:{role:'OWNER'}}))throw new Error('Đã có tài khoản chủ quán. Sử dụng giao diện quản lý tài khoản.');const password=process.env.OWNER_PASSWORD??randomBytes(24).toString('base64url');if(password.length<12)throw new Error('Mật khẩu tối thiểu 12 ký tự.');await db.shop.upsert({where:{id:'main'},create:{id:'main'},update:{}});await auth.api.createUser({body:{name:process.env.OWNER_NAME??'Chủ quán',email:process.env.OWNER_EMAIL??'owner@example.com',password,role:'OWNER',data:{username,displayUsername:username}}});await mkdir('.runtime',{recursive:true});await writeFile('.runtime/owner-access.txt','Website: '+process.env.APP_URL+'/login\nTên đăng nhập: '+username+'\nMật khẩu: '+password+'\nHãy đổi mật khẩu trong Nhân viên sau lần đăng nhập đầu tiên.\n',{mode:0o600});console.log('Đã tạo chủ quán. Thông tin được ghi riêng tại .runtime/owner-access.txt');}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.$disconnect());
