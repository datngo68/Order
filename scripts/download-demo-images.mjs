import { mkdir,writeFile } from 'node:fs/promises';
const photos={banhmi:'photo-1528735602780-2552fd46c7af',coffee:'photo-1509042239860-f550ce710b93',tea:'photo-1544787219-7f47ccb76574',fries:'photo-1573080496219-bb080dd4f877',rice:'photo-1547592180-85f173990554'};
await mkdir('public/demo',{recursive:true});
for(const [name,id] of Object.entries(photos)){const res=await fetch('https://images.unsplash.com/'+id+'?auto=format&fit=crop&w=800&q=85',{signal:AbortSignal.timeout(30000)});if(!res.ok)throw new Error(name+': '+res.status);await writeFile('public/demo/'+name+'.jpg',Buffer.from(await res.arrayBuffer()));console.log('Saved '+name);}
