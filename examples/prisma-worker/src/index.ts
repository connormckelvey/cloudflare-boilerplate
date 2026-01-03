import { PrismaClient } from '../prisma/generated/cloudflare/client';
import { createPrismaClient } from '@cloudflare-boilerplate/prisma';

export interface Env {
  HYPERDRIVE?: {
    connectionString: string;
  };
  DATABASE_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Create Prisma client using our library
      // By default, it looks for env.HYPERDRIVE.connectionString
      // For custom binding names, use the function approach:
      // const prisma = createPrismaClient(PrismaClient, env, {
      //   getConnectionString: (env) => env.MY_CUSTOM_BINDING?.connectionString ?? env.DATABASE_URL
      // });
      const prisma = createPrismaClient(PrismaClient, env, {
        getConnectionString: (env) => env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL
      });

      // Example query - get all posts
      const posts = await prisma.post.findMany();

      return Response.json({
        success: true,
        count: posts.length,
        posts,
      });
    } catch (error) {
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 }
      );
    }
  },
};

