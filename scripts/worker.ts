import 'dotenv/config';
import { paymentWorkerTick,bankConfigured } from '../src/lib/payments';
import { db } from '../src/lib/db';
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
async function main(){console.log('Order payment worker started');while(!stopping){try{if(bankConfigured())await paymentWorkerTick();else await db.requestLimit.deleteMany({where:{expiresAt:{lt:new Date()}}});}catch(e){console.error('Worker tick failed',e instanceof Error?e.message:'unknown');}await new Promise(r=>setTimeout(r,10000));}await db.$disconnect();}
main().catch(()=>process.exit(1));
