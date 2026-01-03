# Basic Worker Example

A simple example Cloudflare Worker that demonstrates using `@cloudflare-boilerplate/prisma`.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set up your database connection:
   - For local development: 
     - Copy `.env.example` to `.env` and fill in your connection strings
     - **Note**: Due to a [Wrangler bug](https://github.com/cloudflare/workers-sdk/issues/8157), Wrangler reads Hyperdrive local connection strings from `.env` (not `.dev.vars`), so we use `.env` for all local environment variables
   - For production: Configure Hyperdrive using the Wrangler CLI:
     ```bash
     # Create a Hyperdrive configuration using your Supabase connection pooling URL
     npx wrangler hyperdrive create my-hyperdrive \
       --connection-string "postgres://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:6543/postgres"
     
     # Update the Hyperdrive to disable caching
     npx wrangler hyperdrive update <hyperdrive-id> \
       --origin-password [YOUR-PASSWORD] \
       --caching-disabled true
     
     # Update the ID in wrangler.jsonc with the Hyperdrive ID from the create command
     ```

3. Generate Prisma client:
```bash
npm run db:generate
```

4. Push your schema to the database:
```bash
# Prisma CLI will read DATABASE_URL from .env automatically
npm run db:push
```

## Development

Run the worker locally:
```bash
npm run dev
```

The worker will be available at `http://localhost:8787` and will query all posts from your database.

## Testing

1. Make sure your database is accessible and has the `posts` table (run `npm run db:push` to create it)
2. Start the dev server: `npm run dev`
3. Visit `http://localhost:8787` in your browser or use curl:
```bash
curl http://localhost:8787
```

You should see a JSON response with the posts from your database.

