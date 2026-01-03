/**
 * Prisma Client Factory for Cloudflare Workers
 * 
 * This module provides a factory function to create Prisma clients that work
 * seamlessly with Cloudflare Workers, Hyperdrive, and local development.
 * 
 * Users must pass their generated PrismaClient class (e.g., from './generated/client/client')
 */

import { PrismaPg } from '@prisma/adapter-pg';
import type { CloudflareEnv, PrismaClientOptions, HyperdriveBinding } from './types.js';

/**
 * Helper function to extract connection string from a Hyperdrive binding
 */
function getHyperdriveConnectionString(env: Record<string, unknown>, bindingName: string): string | undefined {
  const binding = env[bindingName];
  if (binding && typeof binding === 'object' && binding !== null && 'connectionString' in binding) {
    const connectionString = (binding as HyperdriveBinding).connectionString;
    if (typeof connectionString === 'string') {
      return connectionString;
    }
  }
  return undefined;
}

/**
 * Gets the connection string from the environment
 * Priority order:
 * 1. options.connectionString (explicit override)
 * 2. options.getConnectionString(env) (user-provided function)
 * 3. env.HYPERDRIVE.connectionString (default Hyperdrive binding)
 * 4. env.DATABASE_URL (direct connection)
 * 5. process.env.DATABASE_URL (fallback for Node.js environments)
 */
function getConnectionString<TEnv extends CloudflareEnv>(
  env: TEnv | undefined,
  options?: PrismaClientOptions<TEnv>
): string {
  // Explicit override takes highest priority
  if (options?.connectionString) {
    return options.connectionString;
  }

  // User-provided function for type-safe access
  if (options?.getConnectionString && env) {
    const connectionString = options.getConnectionString(env);
    if (connectionString) {
      return connectionString;
    }
  }

  // Try default Hyperdrive binding name
  if (env) {
    const connectionString = getHyperdriveConnectionString(env as Record<string, unknown>, 'HYPERDRIVE');
    if (connectionString) {
      return connectionString;
    }
  }

  // Fall back to direct DATABASE_URL
  if (env?.DATABASE_URL && typeof env.DATABASE_URL === 'string') {
    return env.DATABASE_URL;
  }

  // Last resort: check process.env (for Node.js environments)
  if (typeof process !== 'undefined' && process.env?.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // No connection string found
  throw new Error(
    'No database connection string found. Please provide one of:\n' +
    '  - options.connectionString (explicit override)\n' +
    '  - options.getConnectionString (function for type-safe access)\n' +
    '  - env.HYPERDRIVE.connectionString (default Hyperdrive binding)\n' +
    '  - env.DATABASE_URL (for direct connection)\n' +
    '  - process.env.DATABASE_URL (for Node.js environments)\n\n' +
    'See the README for setup instructions.'
  );
}

/**
 * Creates a Prisma client configured for Cloudflare Workers
 * 
 * This function automatically handles:
 * - Hyperdrive connection pooling (when available)
 * - Direct database connections (for local development)
 * - Proper adapter configuration for Cloudflare Workers runtime
 * 
 * @param PrismaClientClass - Your generated PrismaClient class (e.g., from './generated/client/client')
 * @param env - Cloudflare environment object with HYPERDRIVE or DATABASE_URL
 * @param options - Optional configuration for the Prisma client
 * @returns Configured PrismaClient instance
 * 
 * @example
 * ```typescript
 * // In a Cloudflare Worker
 * import { PrismaClient } from './generated/client/client'
 * import { createPrismaClient } from '@cloudflare-boilerplate/prisma'
 * 
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const prisma = createPrismaClient(PrismaClient, env)
 *     const users = await prisma.user.findMany()
 *     return Response.json(users)
 *   }
 * }
 * ```
 * 
 * @example
 * ```typescript
 * // Local development with DATABASE_URL
 * import { PrismaClient } from './generated/client/client'
 * import { createPrismaClient } from '@cloudflare-boilerplate/prisma'
 * 
 * const prisma = createPrismaClient(PrismaClient, { DATABASE_URL: process.env.DATABASE_URL })
 * ```
 */
export function createPrismaClient<
  TPrismaClient extends new (...args: any[]) => any,
  TEnv extends CloudflareEnv = CloudflareEnv
>(
  PrismaClientClass: TPrismaClient,
  env?: TEnv,
  options?: PrismaClientOptions<TEnv>
): InstanceType<TPrismaClient> {
  const connectionString = getConnectionString(env, options);

  // Create the Prisma adapter for Cloudflare Workers
  const adapter = new PrismaPg({ connectionString });

  // Build client options
  const clientOptions: { adapter: PrismaPg; log?: boolean | Array<'query' | 'info' | 'warn' | 'error'> } = {
    adapter,
    ...(options?.log && { log: options.log }),
  };

  return new PrismaClientClass(clientOptions) as InstanceType<TPrismaClient>;
}

/**
 * Convenience wrapper for creating Prisma clients in Cloudflare Workers
 * 
 * This is a shorthand for `createPrismaClient(PrismaClient, env)` that's commonly used
 * in Cloudflare Worker handlers.
 * 
 * @param PrismaClientClass - Your generated PrismaClient class (e.g., from './generated/client/client')
 * @param env - Cloudflare environment object (typically from Worker's env parameter)
 * @returns Configured PrismaClient instance
 * 
 * @example
 * ```typescript
 * import { PrismaClient } from './generated/client/client'
 * import { getPrisma } from '@cloudflare-boilerplate/prisma'
 * 
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const prisma = getPrisma(PrismaClient, env)
 *     const data = await prisma.user.findMany()
 *     return Response.json(data)
 *   }
 * }
 * ```
 */
export function getPrisma<
  TPrismaClient extends new (...args: any[]) => any,
  TEnv extends CloudflareEnv = CloudflareEnv
>(
  PrismaClientClass: TPrismaClient,
  env: TEnv
): InstanceType<TPrismaClient> {
  return createPrismaClient(PrismaClientClass, env);
}
