import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPrismaClient, getPrisma } from './client.js';
import type { CloudflareEnv } from './types.js';

// Mock PrismaPg adapter
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn().mockImplementation(({ connectionString }) => ({
    connectionString,
  })),
}));

describe('createPrismaClient', () => {
  // Mock PrismaClient constructor
  const MockPrismaClient = vi.fn().mockImplementation((options) => ({
    adapter: options?.adapter,
    log: options?.log,
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear process.env.DATABASE_URL before each test
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  describe('connection string resolution', () => {
    it('should use explicit connectionString option', () => {
      const env = { DATABASE_URL: 'postgres://env-url' };
      const client = createPrismaClient(MockPrismaClient, env, {
        connectionString: 'postgres://explicit-url',
      });

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://explicit-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });

    it('should use getConnectionString function when provided', () => {
      const env = {
        DATABASE_URL: 'postgres://env-url',
        MY_HYPERDRIVE: { connectionString: 'postgres://hyperdrive-url' },
      };
      const client = createPrismaClient(MockPrismaClient, env, {
        getConnectionString: (e) => e.MY_HYPERDRIVE?.connectionString ?? e.DATABASE_URL,
      });

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://hyperdrive-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });

    it('should use default HYPERDRIVE binding when available', () => {
      const env = {
        HYPERDRIVE: { connectionString: 'postgres://hyperdrive-url' },
        DATABASE_URL: 'postgres://env-url',
      };
      const client = createPrismaClient(MockPrismaClient, env);

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://hyperdrive-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });

    it('should fall back to env.DATABASE_URL when HYPERDRIVE is not available', () => {
      const env = { DATABASE_URL: 'postgres://env-url' };
      const client = createPrismaClient(MockPrismaClient, env);

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://env-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });

    it('should fall back to process.env.DATABASE_URL in Node.js environments', () => {
      process.env.DATABASE_URL = 'postgres://process-env-url';
      const client = createPrismaClient(MockPrismaClient);

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://process-env-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });

    it('should throw error when no connection string is found', () => {
      expect(() => {
        createPrismaClient(MockPrismaClient);
      }).toThrow(/No database connection string found/);
    });

    it('should prioritize connectionString over getConnectionString', () => {
      const env = { DATABASE_URL: 'postgres://env-url' };
      const client = createPrismaClient(MockPrismaClient, env, {
        connectionString: 'postgres://explicit-url',
        getConnectionString: () => 'postgres://function-url',
      });

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://explicit-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });

    it('should prioritize getConnectionString over HYPERDRIVE', () => {
      const env = {
        HYPERDRIVE: { connectionString: 'postgres://hyperdrive-url' },
        DATABASE_URL: 'postgres://env-url',
      };
      const client = createPrismaClient(MockPrismaClient, env, {
        getConnectionString: () => 'postgres://function-url',
      });

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://function-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });
  });

  describe('client options', () => {
    it('should pass log option when provided', () => {
      const env = { DATABASE_URL: 'postgres://test-url' };
      const client = createPrismaClient(MockPrismaClient, env, {
        log: ['query', 'info'],
      });

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.any(Object),
          log: ['query', 'info'],
        })
      );
      expect(client).toBeDefined();
    });

    it('should pass boolean log option when provided', () => {
      const env = { DATABASE_URL: 'postgres://test-url' };
      const client = createPrismaClient(MockPrismaClient, env, {
        log: true,
      });

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.any(Object),
          log: true,
        })
      );
      expect(client).toBeDefined();
    });

    it('should not include log option when not provided', () => {
      const env = { DATABASE_URL: 'postgres://test-url' };
      createPrismaClient(MockPrismaClient, env);

      const callArgs = MockPrismaClient.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('log');
    });
  });

  describe('getPrisma', () => {
    it('should be a convenience wrapper for createPrismaClient', () => {
      const env: CloudflareEnv = { DATABASE_URL: 'postgres://test-url' };
      const client = getPrisma(MockPrismaClient, env);

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://test-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });

    it('should require env parameter', () => {
      // @ts-expect-error - Testing that env is required
      expect(() => getPrisma(MockPrismaClient)).toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle empty env object', () => {
      process.env.DATABASE_URL = 'postgres://process-env-url';
      const client = createPrismaClient(MockPrismaClient, {});

      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://process-env-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });

    it('should handle Hyperdrive binding with wrong structure', () => {
      const env = {
        HYPERDRIVE: { wrongProperty: 'value' },
        DATABASE_URL: 'postgres://env-url',
      };
      const client = createPrismaClient(MockPrismaClient, env);

      // Should fall back to DATABASE_URL
      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://env-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });

    it('should handle getConnectionString returning undefined', () => {
      const env = { DATABASE_URL: 'postgres://env-url' };
      const client = createPrismaClient(MockPrismaClient, env, {
        getConnectionString: () => undefined,
      });

      // Should fall back to DATABASE_URL
      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: expect.objectContaining({
            connectionString: 'postgres://env-url',
          }),
        })
      );
      expect(client).toBeDefined();
    });
  });
});

