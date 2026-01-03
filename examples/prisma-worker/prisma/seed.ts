// For seeding in Node.js, we use the Node.js-compatible Prisma client
// and our library to create it with the adapter
import { PrismaClient } from './generated/node/client';
import { createPrismaClient } from '@cloudflare-boilerplate/prisma';

// Use our library to create the Prisma client with DATABASE_URL
const prisma = createPrismaClient(PrismaClient, {
  DATABASE_URL: process.env.DATABASE_URL,
});

async function main() {
  console.log('Seeding database...');

  // Clear existing posts
  await prisma.post.deleteMany();

  // Create seed posts
  const posts = await Promise.all([
    prisma.post.create({
      data: {
        title: 'Welcome to Prisma on Cloudflare Workers',
        content: 'This is the first post seeded into the database. It demonstrates how to use Prisma with Cloudflare Workers and Hyperdrive.',
        published: true,
      },
    }),
    prisma.post.create({
      data: {
        title: 'Getting Started with Hyperdrive',
        content: 'Hyperdrive provides connection pooling and caching for your database connections in Cloudflare Workers.',
        published: true,
      },
    }),
    prisma.post.create({
      data: {
        title: 'Type-Safe Database Queries',
        content: 'With Prisma, you get full type safety for all your database queries, making development faster and safer.',
        published: true,
      },
    }),
    prisma.post.create({
      data: {
        title: 'Draft Post',
        content: 'This is a draft post that has not been published yet.',
        published: false,
      },
    }),
    prisma.post.create({
      data: {
        title: 'Using Supabase with Cloudflare Workers',
        content: 'Supabase provides a powerful PostgreSQL database that works seamlessly with Cloudflare Workers through Hyperdrive. This combination gives you the best of both worlds: Supabase\'s developer-friendly database features and Cloudflare\'s global edge network.',
        published: true,
      },
    }),
  ]);

  console.log(`Created ${posts.length} posts:`);
  posts.forEach((post: { title: string; published: boolean }) => {
    console.log(`  - ${post.title} (${post.published ? 'published' : 'draft'})`);
  });
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

