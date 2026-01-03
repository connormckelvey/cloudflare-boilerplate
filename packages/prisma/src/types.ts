/**
 * Type definitions for Cloudflare environment bindings
 */

/**
 * Hyperdrive binding structure from Cloudflare Workers
 */
export interface HyperdriveBinding {
  connectionString: string;
}

/**
 * Cloudflare environment type for database connections
 * Supports both Hyperdrive (production) and direct DATABASE_URL (development)
 * 
 * This is a base type that users can extend with their own Env interface.
 * Users can name their Hyperdrive binding whatever they want.
 */
export type CloudflareEnv = {
  /**
   * Direct database connection URL
   * Used as fallback when Hyperdrive is not available (e.g., local development)
   */
  DATABASE_URL?: string;
};

/**
 * Options for creating a Prisma client
 */
export interface PrismaClientOptions<TEnv extends CloudflareEnv = CloudflareEnv> {
  /**
   * Custom connection string override
   * If provided, this takes precedence over all other connection sources
   */
  connectionString?: string;

  /**
   * Function to extract the connection string from the environment
   * This allows type-safe access to custom Hyperdrive binding names
   * 
   * @example
   * ```typescript
   * createPrismaClient(PrismaClient, env, {
   *   getConnectionString: (env) => env.MY_CUSTOM_HYPERDRIVE?.connectionString ?? env.DATABASE_URL
   * })
   * ```
   */
  getConnectionString?: (env: TEnv) => string | undefined;

  /**
   * Whether to log queries (useful for debugging)
   * @default false
   */
  log?: boolean | Array<'query' | 'info' | 'warn' | 'error'>;
}


