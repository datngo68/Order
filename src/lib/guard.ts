import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from './auth';
export async function guard(roles=['OWNER','CASHIER','KITCHEN']){const session=await auth.api.getSession({headers:await headers()});if(!session)redirect('/login');const role=session.user.role??'';if(!roles.includes(role))redirect(role==='KITCHEN'?'/kitchen':'/pos');return {id:session.user.id,name:session.user.name,role};}
