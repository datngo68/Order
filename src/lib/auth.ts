import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin, username } from 'better-auth/plugins';
import { adminAc, userAc } from 'better-auth/plugins/admin/access';
import { db } from './db';
export const auth=betterAuth({
 database:prismaAdapter(db,{provider:'postgresql'}),
 baseURL:process.env.BETTER_AUTH_URL ?? process.env.APP_URL,
 secret:process.env.BETTER_AUTH_SECRET,
 emailAndPassword:{enabled:true,disableSignUp:true,minPasswordLength:12},
 session:{expiresIn:60*60*12,updateAge:60*30},
 rateLimit:{enabled:true,window:60,max:30,customRules:{'/sign-in/username':{window:60,max:8},'/sign-in/email':{window:60,max:8}}},
 plugins:[username(),admin({defaultRole:'CASHIER',adminRoles:['OWNER'],roles:{OWNER:adminAc,CASHIER:userAc,KITCHEN:userAc}})],
 advanced:{useSecureCookies:process.env.APP_URL?.startsWith('https://')??false}
});
export type Actor={id:string;name:string;role:string};
