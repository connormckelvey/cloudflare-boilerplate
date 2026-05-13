import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDOQueue } from "./queue";
import { computeBackoff } from "./retry";
import type { MessageBatch, StoredMessage } from "./types";

// --- Mock DO storage as an in-memory sorted map ---

class MockStorage {
  private data = new Map<string, unknown>();
  public alarmTime: number | null = null;

  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let count = 0;
      for (const k of key) {
        if (this.data.delete(k)) count++;
      }
      return count;
    }
    return this.data.delete(key);
  }

  async list<T>(opts: { prefix: string; limit?: number }): Promise<Map<string, T>> {
    const entries = new Map<string, T>();
    const sorted = [...this.data.entries()]
      .filter(([k]) => k.startsWith(opts.prefix))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of sorted.slice(0, opts.limit ?? sorted.length)) {
      entries.set(k, structuredClone(v) as T);
    }
    return entries;
  }

  async setAlarm(time: number) {
    this.alarmTime = time;
  }

  async transaction<T>(closure: (txn: MockStorage) => Promise<T>) {
    return closure(this);
  }

  get messageCount() {
    return [...this.data.keys()].filter((k) => k.startsWith("msg:")).length;
  }

  async messages<T>() {
    return [...(await this.list<StoredMessage<T>>({ prefix: "msg:" })).values()];
  }
}

function createMockDO<T, Env>(
  DOClass: ReturnType<typeof createDOQueue<T, Env>>,
  env: Env
) {
  const storage = new MockStorage();
  const waitUntilPromises: Promise<unknown>[] = [];

  const ctx = {
    storage,
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    },
  } as unknown as DurableObjectState;

  const instance = new DOClass(ctx, env);

  return {
    instance,
    storage,
    waitUntilPromises,
    async enqueue(body: T, queue = "test-queue") {
      const result = await instance.enqueue({ queue, body });
      await Promise.all(waitUntilPromises.splice(0));
      return result;
    },
    async enqueueWithoutDrain(body: T, queue = "test-queue") {
      return instance.enqueue({ queue, body });
    },
    async drain() {
      await Promise.all(waitUntilPromises.splice(0));
    },
    async triggerAlarm() {
      storage.alarmTime = null;
      await instance.alarm();
    },
  };
}

function advancePastAlarm(storage: MockStorage) {
  vi.spyOn(Date, "now").mockReturnValue((storage.alarmTime ?? Date.now()) + 1);
}

// --- Tests ---

describe("createDOQueue", () => {
  describe("batch delivery", () => {
    it("implicitly acknowledges unsettled messages when queue() succeeds", async () => {
      const processed: string[] = [];
      const DOClass = createDOQueue<string, {}>({
        async queue(batch) {
          processed.push(...batch.messages.map((message) => message.body));
        },
      });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("hello");

      expect(processed).toEqual(["hello"]);
      expect(mock.storage.messageCount).toBe(0);
    });

    it("returns a messageId on enqueue", async () => {
      const DOClass = createDOQueue<string, {}>({
        async queue() {},
      });

      const mock = createMockDO(DOClass, {});
      const result = await mock.enqueue("test");

      expect(result.messageId).toBeDefined();
      expect(typeof result.messageId).toBe("string");
    });

    it("delivers queued messages in batches up to maxBatchSize", async () => {
      const batches: number[][] = [];
      let release: (() => void) | null = null;

      const DOClass = createDOQueue<number, {}>({
        async queue(batch) {
          batches.push(batch.messages.map((message) => message.body));
          if (batches.length === 1) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        },
      }, { maxBatchSize: 2 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueueWithoutDrain(1);
      await mock.enqueueWithoutDrain(2);
      await mock.enqueueWithoutDrain(3);

      release!();
      await mock.drain();

      expect(batches).toEqual([[1], [2, 3]]);
      expect(mock.storage.messageCount).toBe(0);
    });

    it("preserves FIFO for same-millisecond enqueues", async () => {
      const order: number[] = [];
      let release: (() => void) | null = null;

      const DOClass = createDOQueue<number, {}>({
        async queue(batch) {
          if (order.length === 0) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          order.push(...batch.messages.map((message) => message.body));
        },
      }, { maxBatchSize: 10 });

      const mock = createMockDO(DOClass, {});
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);

      await mock.enqueueWithoutDrain(1);
      await mock.enqueueWithoutDrain(2);
      await mock.enqueueWithoutDrain(3);

      release!();
      await mock.drain();
      vi.restoreAllMocks();

      expect(order).toEqual([1, 2, 3]);
    });

    it("passes env and waitUntil context to queue()", async () => {
      let receivedEnv: { secret: string } | null = null;
      const sideEffects: string[] = [];
      const DOClass = createDOQueue<string, { secret: string }>({
        async queue(batch, env, ctx) {
          receivedEnv = env;
          ctx.waitUntil(Promise.resolve().then(() => sideEffects.push(batch.queue)));
        },
      });

      const mock = createMockDO(DOClass, { secret: "test-key" });
      await mock.enqueue("test", "jobs");

      expect(receivedEnv).toEqual({ secret: "test-key" });
      expect(sideEffects).toEqual(["jobs"]);
      expect(mock.storage.messageCount).toBe(0);
    });
  });

  describe("ack and retry settlement", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("retries unsettled messages when queue() throws", async () => {
      let calls = 0;
      const DOClass = createDOQueue<string, {}>({
        async queue() {
          calls++;
          if (calls === 1) {
            throw new Error("transient failure");
          }
        },
      }, { retryBaseDelayMs: 100 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("retry-me");

      expect(mock.storage.messageCount).toBe(1);
      expect(mock.storage.alarmTime).not.toBeNull();
      expect(calls).toBe(1);

      advancePastAlarm(mock.storage);
      await mock.triggerAlarm();
      vi.restoreAllMocks();

      expect(calls).toBe(2);
      expect(mock.storage.messageCount).toBe(0);
    });

    it("passes Cloudflare-style attempts starting at 1", async () => {
      const attempts: number[] = [];
      const DOClass = createDOQueue<string, {}>({
        async queue(batch) {
          attempts.push(batch.messages[0].attempts);
          if (batch.messages[0].attempts < 3) {
            batch.retryAll({ delaySeconds: 0 });
          }
        },
      }, { maxRetries: 3 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("test");

      expect(attempts).toEqual([1, 2, 3]);
      expect(mock.storage.messageCount).toBe(0);
    });

    it("keeps explicit ack when queue() throws later", async () => {
      let calls = 0;
      const DOClass = createDOQueue<string, {}>({
        async queue(batch) {
          calls++;
          batch.messages[0].ack();
          throw new Error("fail after ack");
        },
      }, { retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("done");

      expect(calls).toBe(1);
      expect(mock.storage.messageCount).toBe(0);
    });

    it("supports explicit retry with delaySeconds", async () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const DOClass = createDOQueue<string, {}>({
        async queue(batch) {
          if (batch.messages[0].attempts === 1) {
            batch.messages[0].retry({ delaySeconds: 30 });
          }
        },
      });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("later");

      const [stored] = await mock.storage.messages<string>();
      expect(stored.retryAfter).toBe(now + 30_000);
      expect(mock.storage.alarmTime).toBe(now + 30_000);
      vi.restoreAllMocks();
    });

    it("uses first settlement wins for message-level ack and retry", async () => {
      const calls: number[] = [];
      const DOClass = createDOQueue<number, {}>({
        async queue(batch) {
          calls.push(batch.messages[0].attempts);
          batch.messages[0].retry({ delaySeconds: 0 });
          batch.messages[0].ack();
        },
      }, { maxRetries: 1 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue(1);

      expect(calls).toEqual([1, 2]);
      expect(mock.storage.messageCount).toBe(0);
    });

    it("does not let ackAll override an explicitly retried message", async () => {
      const calls: number[] = [];
      const DOClass = createDOQueue<number, {}>({
        async queue(batch) {
          calls.push(batch.messages[0].attempts);
          batch.messages[0].retry({ delaySeconds: 0 });
          batch.ackAll();
        },
      }, { maxRetries: 1 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue(1);

      expect(calls).toEqual([1, 2]);
      expect(mock.storage.messageCount).toBe(0);
    });

    it("retries unsettled messages when waitUntil rejects", async () => {
      let calls = 0;
      const DOClass = createDOQueue<string, {}>({
        async queue(_batch, _env, ctx) {
          calls++;
          if (calls === 1) {
            ctx.waitUntil(Promise.reject(new Error("async failure")));
          }
        },
      }, { retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("retry");

      expect(calls).toBe(1);
      expect(mock.storage.messageCount).toBe(1);

      advancePastAlarm(mock.storage);
      await mock.triggerAlarm();
      vi.restoreAllMocks();

      expect(calls).toBe(2);
      expect(mock.storage.messageCount).toBe(0);
    });
  });

  describe("dead letter", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("deadLetters after maxRetries retries are exhausted", async () => {
      const attempts: number[] = [];
      const deadLettered: Array<{ id: string; attempts: number; error: string }> = [];
      const DOClass = createDOQueue<string, {}>({
        async queue(batch) {
          attempts.push(batch.messages[0].attempts);
          throw new Error("always fails");
        },
        async deadLetter(message, error) {
          deadLettered.push({
            id: message.id,
            attempts: message.attempts,
            error: error.message,
          });
        },
      }, { maxRetries: 2, retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("doomed");

      advancePastAlarm(mock.storage);
      await mock.triggerAlarm();
      advancePastAlarm(mock.storage);
      await mock.triggerAlarm();
      vi.restoreAllMocks();

      expect(attempts).toEqual([1, 2, 3]);
      expect(deadLettered).toHaveLength(1);
      expect(deadLettered[0].attempts).toBe(3);
      expect(deadLettered[0].error).toBe("always fails");
      expect(mock.storage.messageCount).toBe(0);
    });

    it("deletes exhausted messages when no deadLetter callback is configured", async () => {
      const DOClass = createDOQueue<string, {}>({
        async queue(batch) {
          batch.retryAll({ delaySeconds: 0 });
        },
      }, { maxRetries: 0 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("doomed");

      expect(mock.storage.messageCount).toBe(0);
    });

    it("retains message when deadLetter handler throws", async () => {
      let processCalls = 0;
      let dlqCalls = 0;
      const DOClass = createDOQueue<string, {}>({
        async queue() {
          processCalls++;
          throw new Error("always fails");
        },
        async deadLetter() {
          dlqCalls++;
          throw new Error("DLQ handler also fails");
        },
      }, { maxRetries: 0, retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("doomed");

      expect(processCalls).toBe(1);
      expect(dlqCalls).toBe(1);
      expect(mock.storage.messageCount).toBe(1);
      expect(mock.storage.alarmTime).not.toBeNull();
    });

    it("retries deadLetter handler without rerunning queue()", async () => {
      let processCalls = 0;
      let dlqCalls = 0;
      const DOClass = createDOQueue<string, {}>({
        async queue() {
          processCalls++;
          throw new Error("always fails");
        },
        async deadLetter() {
          dlqCalls++;
          if (dlqCalls === 1) {
            throw new Error("DLQ transient failure");
          }
        },
      }, { maxRetries: 0, retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      await mock.enqueue("doomed");

      vi.spyOn(Date, "now").mockReturnValue(now + 100000);
      await mock.triggerAlarm();
      vi.restoreAllMocks();

      expect(processCalls).toBe(1);
      expect(dlqCalls).toBe(2);
      expect(mock.storage.messageCount).toBe(0);
    });
  });

  describe("stats RPC", () => {
    it("returns pending message count", async () => {
      let release: (() => void) | null = null;
      const DOClass = createDOQueue<string, {}>({
        async queue() {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      });

      const mock = createMockDO(DOClass, {});

      const emptyStats = await mock.instance.stats();
      expect(emptyStats.pendingMessages).toBe(0);

      await mock.enqueueWithoutDrain("msg");

      const stats = await mock.instance.stats();
      expect(stats.pendingMessages).toBe(1);

      release!();
      await mock.drain();
    });
  });
});

describe("computeBackoff", () => {
  it("returns base delay for first attempt", () => {
    const result = computeBackoff(1, 1000, 30000, 0);
    expect(result).toBe(1000);
  });

  it("doubles delay for each attempt", () => {
    const r1 = computeBackoff(1, 1000, 30000, 0);
    const r2 = computeBackoff(2, 1000, 30000, 0);
    const r3 = computeBackoff(3, 1000, 30000, 0);
    expect(r1).toBe(1000);
    expect(r2).toBe(2000);
    expect(r3).toBe(4000);
  });

  it("caps at maxDelayMs", () => {
    const result = computeBackoff(100, 1000, 30000, 0);
    expect(result).toBe(30000);
  });

  it("adds jitter when jitter > 0", () => {
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      results.add(computeBackoff(1, 1000, 30000, 0.5));
    }
    expect(results.size).toBeGreaterThan(1);
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(1000);
      expect(r).toBeLessThanOrEqual(1500);
    }
  });
});
