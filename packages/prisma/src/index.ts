/**
 * @cloudflare-boilerplate/prisma
 * 
 * A reusable library for Prisma + Hyperdrive + Supabase integration
 * in Cloudflare Workers projects.
 * 
 * @module
 */

export { createPrismaClient, getPrisma } from './client.js';
export type {
  CloudflareEnv,
  HyperdriveBinding,
  PrismaClientOptions,
} from './types.js';
