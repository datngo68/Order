import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalDb.prisma ?? new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
if (process.env.NODE_ENV !== 'production') globalDb.prisma = db;
export type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
