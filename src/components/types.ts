import type { Prisma,Product,Category,Shop } from '@/generated/prisma/client';
export type Serialized<T>=T extends Date?string:T extends Array<infer U>?Serialized<U>[]:T extends object?{[K in keyof T]:Serialized<T[K]>}:T;
export type Catalog={shop:Serialized<Shop>;categories:(Serialized<Category>&{products:Serialized<Product>[]})[]};
export type ProductView=Serialized<Product>;
export type OrderView=Serialized<Awaited<ReturnType<typeof import('@/lib/orders').getOrder>>>;
export type Staff={id:string;name:string;role:string};
export type DiningTableView=Serialized<Awaited<ReturnType<typeof import('@/lib/tables').listTables>>[number]>;
export type TableVisitView=Serialized<Awaited<ReturnType<typeof import('@/lib/tables').publicVisit>>>;
