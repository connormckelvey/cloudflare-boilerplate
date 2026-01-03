# @cloudflare-boilerplate/prisma

A reusable npm library that abstracts the Supabase/Prisma/Hyperdrive integration pattern, making it easy to bootstrap new Cloudflare Workers projects with database connectivity.

## Features

- ✅ **Seamless Hyperdrive Integration** - Automatically uses Hyperdrive connection pooling in Cloudflare Workers
- ✅ **Local Development Support** - Falls back to `DATABASE_URL` for local development
- ✅ **Type-Safe** - Full TypeScript support with proper type inference
- ✅ **Prisma Compatible** - Works with existing Prisma workflows and tooling
- ✅ **Zero Configuration** - Works out of the box with sensible defaults
- ✅ **Clear Error Messages** - Helpful errors when configuration is missing

## Installation

```bash
npm install @cloudflare-boilerplate/prisma @prisma/client
npm install -D prisma
```

**Note:** `@prisma/adapter-pg` is automatically installed as a dependency of this package, so you don't need to install it separately.

## Quick Start

### 1. Set Up Prisma Schema

Create a `prisma/schema.prisma` file in your project:

```prisma
generator client {
  provider = "prisma-client"
  runtime  = "cloudflare"
  output   = "./generated"
}

datasource db {
  provider = "postgresql"
}

model Post {
  id        String   @id @default(cuid())
  title     String
  content   String?
  published Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

**Note:** In Prisma 7+, the `url` field is no longer in the schema file. Create a `prisma.config.ts` file in your project root:

```typescript
import { defineConfig } from 'prisma/config';

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
```

### 2. Generate Prisma Client

```bash
npx prisma generate
```

### 3. Configure Wrangler (for Cloudflare Workers)

Add Hyperdrive binding to your `wrangler.toml` or `wrangler.json`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-config-id"
```

Or in `wrangler.json`:

```json
{
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "your-hyperdrive-config-id"
    }
  ]
}
```

**Important:** For local development, create a `.env` file in your project root with:

```env
DATABASE_URL=postgresql://user:password@host:port/database
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://user:password@host:port/database
```

**Note:** Wrangler reads Hyperdrive local connection strings from `.env` (not `.dev.vars`). Use `.env` for all local environment variables, including `DATABASE_URL` for Prisma CLI commands.

### 4. Use in Your Cloudflare Worker

```typescript
import { PrismaClient } from '../prisma/generated/client';
import { getPrisma } from '@cloudflare-boilerplate/prisma';

export interface Env {
  HYPERDRIVE: {
    connectionString: string;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const prisma = getPrisma(PrismaClient, env);
    const posts = await prisma.post.findMany();
    return Response.json(posts);
  },
};
```

## Configuration

### Cloudflare Workers with Hyperdrive (Production)

The library automatically detects and uses Hyperdrive when available. By default, it looks for a binding named `HYPERDRIVE`, but you can use any name:

```typescript
import { PrismaClient } from '../prisma/generated/client';
import { getPrisma } from '@cloudflare-boilerplate/prisma';

// Default: binding named "HYPERDRIVE"
export interface Env {
  HYPERDRIVE: {
    connectionString: string;
  };
}

export default {
  async fetch(request: Request, env: Env) {
    // Automatically uses env.HYPERDRIVE.connectionString
    const prisma = getPrisma(PrismaClient, env);
    // ... use prisma
  },
};
```

**Custom Binding Name (Type-Safe Function):**

If you named your Hyperdrive binding something other than `HYPERDRIVE`, use the `getConnectionString` function for type-safe access:

```typescript
import { PrismaClient } from '../prisma/generated/client';
import { createPrismaClient } from '@cloudflare-boilerplate/prisma';

export interface Env {
  DATABASE: {  // Custom binding name
    connectionString: string;
  };
  DATABASE_URL?: string;
}

export default {
  async fetch(request: Request, env: Env) {
    const prisma = createPrismaClient(PrismaClient, env, {
      getConnectionString: (env) => 
        env.DATABASE?.connectionString ?? env.DATABASE_URL
    });
    // ... use prisma
  },
};
```

### Local Development with DATABASE_URL

For local development, the library falls back to `DATABASE_URL`. Create a `.env` file in your project root:

```env
DATABASE_URL=postgresql://user:password@host:port/database
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://user:password@host:port/database
```

**Note:** Wrangler reads Hyperdrive local connection strings from `.env` (not `.dev.vars`). Use `.env` for all local environment variables.

Then in your code:

```typescript
import { PrismaClient } from '../prisma/generated/client';
import { createPrismaClient } from '@cloudflare-boilerplate/prisma';

// Option 1: Pass DATABASE_URL explicitly
const prisma = createPrismaClient(PrismaClient, {
  DATABASE_URL: process.env.DATABASE_URL,
});

// Option 2: Let it read from process.env automatically
const prisma = createPrismaClient(PrismaClient);
```

### React Router / Remix

```typescript
import { PrismaClient } from '../prisma/generated/client';
import { getPrisma } from '@cloudflare-boilerplate/prisma';

export async function loader({ context }: LoaderArgs) {
  const prisma = getPrisma(PrismaClient, context.cloudflare.env);
  const data = await prisma.post.findMany();
  return { data };
}
```

## API Reference

### `createPrismaClient(PrismaClientClass, env?, options?)`

Creates a Prisma client configured for Cloudflare Workers.

**Parameters:**
- `PrismaClientClass` - Your generated PrismaClient class (e.g., from `'../prisma/generated/client'`)
- `env?` - Optional Cloudflare environment object with Hyperdrive binding or `DATABASE_URL`
- `options?` - Optional configuration:
  - `connectionString?` - Explicit connection string override (highest priority)
  - `getConnectionString?` - Function to extract connection string from env (type-safe, recommended for custom bindings)
  - `log?` - Enable query logging (boolean or array of log levels)

**Returns:** Instance of your PrismaClient type

**Example:**
```typescript
import { PrismaClient } from '../prisma/generated/client';

// Basic usage
const prisma = createPrismaClient(PrismaClient, env, {
  log: ['query', 'error'],
});

// With custom binding name (type-safe)
const prisma = createPrismaClient(PrismaClient, env, {
  getConnectionString: (env) => env.MY_CUSTOM_BINDING?.connectionString ?? env.DATABASE_URL,
});
```

### `getPrisma(PrismaClientClass, env)`

Convenience wrapper for Cloudflare Workers. Equivalent to `createPrismaClient(PrismaClientClass, env)`.

**Parameters:**
- `PrismaClientClass` - Your generated PrismaClient class (e.g., from `'../prisma/generated/client'`)
- `env` - Cloudflare environment object

**Returns:** Instance of your PrismaClient type

**Example:**
```typescript
import { PrismaClient } from '../prisma/generated/client';

const prisma = getPrisma(PrismaClient, env);
```

## Type Exports

```typescript
import type {
  CloudflareEnv,
  HyperdriveBinding,
  PrismaClientOptions,
} from '@cloudflare-boilerplate/prisma';

// Note: Import PrismaClient from your generated client, not from this package
import type { PrismaClient } from '../prisma/generated/client';
```

## Prisma Workflow

### Generate Client

After updating your Prisma schema:

```bash
npx prisma generate
```

For local development, you may want to use `dotenv-cli` to load your `.env` file:

```bash
npm install -D dotenv-cli
npx dotenv -- prisma generate
```

### Push Schema (Development)

```bash
npx prisma db push
```

Or with `dotenv-cli`:

```bash
npx dotenv -- prisma db push
```

### Open Prisma Studio

```bash
npx prisma studio
```

Or with `dotenv-cli`:

```bash
npx dotenv -- prisma studio
```

**Tip:** You can add these to your `package.json` scripts for convenience:

```json
{
  "scripts": {
    "db:generate": "dotenv -- prisma generate",
    "db:push": "dotenv -- prisma db push",
    "db:studio": "dotenv -- prisma studio"
  }
}
```

## Error Handling

The library provides clear error messages when configuration is missing:

```typescript
// If no connection string is found:
Error: No database connection string found. Please provide one of:
  - env.HYPERDRIVE.connectionString (for Cloudflare Workers with Hyperdrive)
  - env.DATABASE_URL (for direct connection)
  - process.env.DATABASE_URL (for Node.js environments)
  - options.connectionString (explicit override)
```

## Advanced Usage

### Custom Connection String

```typescript
import { PrismaClient } from '../prisma/generated/client';
import { createPrismaClient } from '@cloudflare-boilerplate/prisma';

const prisma = createPrismaClient(PrismaClient, env, {
  connectionString: 'postgresql://custom-connection-string',
});
```

### Query Logging

```typescript
import { PrismaClient } from '../prisma/generated/client';
import { createPrismaClient } from '@cloudflare-boilerplate/prisma';

const prisma = createPrismaClient(PrismaClient, env, {
  log: ['query', 'info', 'warn', 'error'],
});
```

### Transactions

```typescript
import { PrismaClient } from '../prisma/generated/client';
import { getPrisma } from '@cloudflare-boilerplate/prisma';

const prisma = getPrisma(PrismaClient, env);

await prisma.$transaction(async (tx) => {
  const post = await tx.post.create({ data: { title: 'Hello World', content: 'My first post' } });
  await tx.post.update({ where: { id: post.id }, data: { published: true } });
});
```

## Troubleshooting

### "No database connection string found"

Make sure you've:
1. Set up Hyperdrive binding in `wrangler.toml`/`wrangler.json` (for production)
2. Set `DATABASE_URL` environment variable (for local development)

### Prisma Client not found

Make sure you've:
1. Installed `@prisma/client`: `npm install @prisma/client`
2. Generated the Prisma client: `npx prisma generate`

### Type errors with PrismaClient

Make sure you've:
1. Generated the Prisma client after updating your schema
2. Restarted your TypeScript server/IDE

## Important Notes

### Environment Variables

- **Production:** Hyperdrive binding provides the connection string automatically
- **Local Development:** Use a `.env` file (not `.dev.vars`) - Wrangler reads Hyperdrive local connection strings from `.env` by design
- **Prisma CLI:** Reads `DATABASE_URL` from `.env` for commands like `prisma db push` and `prisma generate`

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Related

- [Prisma](https://www.prisma.io/)
- [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
- [Supabase](https://supabase.com/)

