import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDOQueue } from "./queue";
import { computeBackoff } from "./retry";
import type { QueueMessage, ConsumerHandler } from "./types";

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

  /** Count only message keys (exclude meta keys) */
  get messageCount() {
    return [...this.data.keys()].filter((k) => k.startsWith("msg:")).length;
  }

  get size() {
    return this.data.size;
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
      const request = new Request("https://do-queue.internal/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue, body }),
      });
      const response = await instance.fetch(request);
      // Wait for processing triggered by waitUntil
      await Promise.all(waitUntilPromises.splice(0));
      return response.json() as Promise<{ messageId: string }>;
    },
    async triggerAlarm() {
      storage.alarmTime = null;
      await instance.alarm();
    },
  };
}

// --- Tests ---

describe("createDOQueue", () => {
  describe("happy path", () => {
    it("processes a message and removes it from storage", async () => {
      const processed: string[] = [];
      const DOClass = createDOQueue<string, {}>({
        async process(message) {
          processed.push(message.body);
        },
      });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("hello");

      expect(processed).toEqual(["hello"]);
      expect(mock.storage.messageCount).toBe(0);
    });

    it("returns a messageId on enqueue", async () => {
      const DOClass = createDOQueue<string, {}>({
        async process() {},
      });

      const mock = createMockDO(DOClass, {});
      const result = await mock.enqueue("test");

      expect(result.messageId).toBeDefined();
      expect(typeof result.messageId).toBe("string");
    });
  });

  describe("FIFO ordering", () => {
    it("processes messages in enqueue order", async () => {
      const order: number[] = [];

      const DOClass = createDOQueue<number, {}>({
        async process(message) {
          order.push(message.body);
        },
      });

      const mock = createMockDO(DOClass, {});

      // Enqueue 3 messages sequentially, each fully processes before next
      await mock.enqueue(1);
      await mock.enqueue(2);
      await mock.enqueue(3);

      expect(order).toEqual([1, 2, 3]);
    });

    it("preserves FIFO for same-millisecond enqueues", async () => {
      const order: number[] = [];
      let block: (() => void) | null = null;

      const DOClass = createDOQueue<number, {}>({
        async process(message) {
          if (order.length === 0) {
            // Block on first message so others queue up
            await new Promise<void>((r) => { block = r; });
          }
          order.push(message.body);
        },
      });

      const mock = createMockDO(DOClass, {});

      // Fix Date.now() so all enqueues share the same millisecond
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);

      // First enqueue starts processing and blocks
      const req1 = new Request("https://do-queue.internal/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue: "test", body: 1 }),
      });
      await mock.instance.fetch(req1);

      // Enqueue 2 and 3 at the same millisecond while first is blocked
      const req2 = new Request("https://do-queue.internal/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue: "test", body: 2 }),
      });
      const req3 = new Request("https://do-queue.internal/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue: "test", body: 3 }),
      });
      await mock.instance.fetch(req2);
      await mock.instance.fetch(req3);

      // Unblock first message — loop should process 2, 3 in sequence order
      block!();
      await Promise.all(mock.waitUntilPromises.splice(0));
      vi.restoreAllMocks();

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("retry", () => {
    it("retries a failed message via alarm", async () => {
      let attempt = 0;
      const DOClass = createDOQueue<string, {}>({
        async process(message) {
          attempt++;
          if (attempt === 1) {
            throw new Error("transient failure");
          }
        },
      }, { maxRetries: 3, retryBaseDelayMs: 100 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("retry-me");

      // First attempt failed, message should still be in storage
      expect(mock.storage.messageCount).toBe(1);
      expect(mock.storage.alarmTime).not.toBeNull();
      expect(attempt).toBe(1);

      // Simulate alarm firing (advance past retryAfter)
      vi.spyOn(Date, "now").mockReturnValue(mock.storage.alarmTime! + 1);
      await mock.triggerAlarm();
      vi.restoreAllMocks();

      // Second attempt should succeed
      expect(attempt).toBe(2);
      expect(mock.storage.messageCount).toBe(0);
    });

    it("passes correct attempt count to handler", async () => {
      const attempts: number[] = [];
      const DOClass = createDOQueue<string, {}>({
        async process(message) {
          attempts.push(message.attempts);
          if (message.attempts < 3) {
            throw new Error("fail");
          }
        },
      }, { maxRetries: 3, retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      await mock.enqueue("test");

      // Attempt 1 failed
      expect(attempts).toEqual([1]);

      // Trigger retry for attempt 2
      vi.spyOn(Date, "now").mockReturnValue(now + 100000);
      await mock.triggerAlarm();
      expect(attempts).toEqual([1, 2]);

      // Trigger retry for attempt 3
      vi.spyOn(Date, "now").mockReturnValue(now + 200000);
      await mock.triggerAlarm();
      vi.restoreAllMocks();

      expect(attempts).toEqual([1, 2, 3]);
    });
  });

  describe("dead letter", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("calls deadLetter after maxRetries exhausted and deletes on success", async () => {
      const deadLettered: Array<{ id: string; error: string }> = [];
      const DOClass = createDOQueue<string, {}>({
        async process() {
          throw new Error("always fails");
        },
        async deadLetter(message, error) {
          deadLettered.push({ id: message.id, error: error.message });
        },
      }, { maxRetries: 2, retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("doomed");

      // Attempt 1 failed, retry scheduled
      expect(deadLettered).toHaveLength(0);

      // Trigger alarm for attempt 2 (which is maxRetries)
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 100000);
      await mock.triggerAlarm();
      vi.restoreAllMocks();

      expect(deadLettered).toHaveLength(1);
      expect(deadLettered[0].error).toBe("always fails");
      expect(mock.storage.messageCount).toBe(0); // removed after successful DLQ
    });

    it("handles missing deadLetter callback gracefully", async () => {
      const DOClass = createDOQueue<string, {}>({
        async process() {
          throw new Error("always fails");
        },
        // no deadLetter callback
      }, { maxRetries: 1, retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("doomed");

      // Should not throw, message should be removed
      expect(mock.storage.messageCount).toBe(0);
    });

    it("retains message when deadLetter handler throws", async () => {
      let dlqCalls = 0;
      const DOClass = createDOQueue<string, {}>({
        async process() {
          throw new Error("always fails");
        },
        async deadLetter() {
          dlqCalls++;
          throw new Error("DLQ handler also fails");
        },
      }, { maxRetries: 1, retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      await mock.enqueue("doomed");

      // process failed (attempt 1 = maxRetries), deadLetter was called and threw
      expect(dlqCalls).toBe(1);
      // Message should be retained in storage for DLQ retry
      expect(mock.storage.messageCount).toBe(1);
      // An alarm should be scheduled for retry
      expect(mock.storage.alarmTime).not.toBeNull();
    });

    it("retries deadLetter handler on alarm and deletes on success", async () => {
      let processCalls = 0;
      let dlqCalls = 0;
      const DOClass = createDOQueue<string, {}>({
        async process() {
          processCalls++;
          throw new Error("always fails");
        },
        async deadLetter() {
          dlqCalls++;
          if (dlqCalls === 1) {
            throw new Error("DLQ transient failure");
          }
          // Second DLQ call succeeds
        },
      }, { maxRetries: 1, retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      await mock.enqueue("doomed");

      // First DLQ attempt failed, message retained
      expect(processCalls).toBe(1);
      expect(dlqCalls).toBe(1);
      expect(mock.storage.messageCount).toBe(1);

      // Trigger alarm — DLQ retry should succeed
      vi.spyOn(Date, "now").mockReturnValue(now + 100000);
      await mock.triggerAlarm();
      vi.restoreAllMocks();

      expect(processCalls).toBe(1);
      expect(dlqCalls).toBe(2);
      expect(mock.storage.messageCount).toBe(0); // now deleted
    });

    it("keeps retrying deadLetter without rerunning process or discarding", async () => {
      let processCalls = 0;
      let dlqCalls = 0;
      const DOClass = createDOQueue<string, {}>({
        async process() {
          processCalls++;
          throw new Error("always fails");
        },
        async deadLetter() {
          dlqCalls++;
          throw new Error("DLQ always fails");
        },
      }, { maxRetries: 1, retryBaseDelayMs: 10 });

      const mock = createMockDO(DOClass, {});
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      await mock.enqueue("doomed");

      // DLQ attempt 1 failed
      expect(processCalls).toBe(1);
      expect(dlqCalls).toBe(1);
      expect(mock.storage.messageCount).toBe(1);

      // DLQ attempt 2
      vi.spyOn(Date, "now").mockReturnValue(now + 100000);
      await mock.triggerAlarm();
      expect(processCalls).toBe(1);
      expect(dlqCalls).toBe(2);
      expect(mock.storage.messageCount).toBe(1);

      // DLQ attempt 3 — still retained, matching a configured Cloudflare DLQ handoff
      vi.spyOn(Date, "now").mockReturnValue(now + 200000);
      await mock.triggerAlarm();
      vi.restoreAllMocks();

      expect(processCalls).toBe(1);
      expect(dlqCalls).toBe(3);
      expect(mock.storage.messageCount).toBe(1);
    });
  });

  describe("env passthrough", () => {
    it("passes env to process handler", async () => {
      let receivedEnv: { secret: string } | null = null;
      const DOClass = createDOQueue<string, { secret: string }>({
        async process(_message, env) {
          receivedEnv = env;
        },
      });

      const mock = createMockDO(DOClass, { secret: "test-key" });
      await mock.enqueue("test");

      expect(receivedEnv).toEqual({ secret: "test-key" });
    });

    it("passes env to deadLetter handler", async () => {
      let receivedEnv: { secret: string } | null = null;
      const DOClass = createDOQueue<string, { secret: string }>({
        async process() {
          throw new Error("fail");
        },
        async deadLetter(_message, _error, env) {
          receivedEnv = env;
        },
      }, { maxRetries: 1 });

      const mock = createMockDO(DOClass, { secret: "dlq-key" });
      await mock.enqueue("test");

      expect(receivedEnv).toEqual({ secret: "dlq-key" });
    });
  });

  describe("stats endpoint", () => {
    it("returns pending message count", async () => {
      let block: (() => void) | null = null;
      const DOClass = createDOQueue<string, {}>({
        async process() {
          await new Promise<void>((r) => { block = r; });
        },
      });

      const mock = createMockDO(DOClass, {});

      // Check empty queue
      const emptyReq = new Request("https://do-queue.internal/stats");
      const emptyRes = await mock.instance.fetch(emptyReq);
      const emptyStats = await emptyRes.json() as { pendingMessages: number };
      expect(emptyStats.pendingMessages).toBe(0);

      // Enqueue without awaiting (so it blocks in process)
      const req = new Request("https://do-queue.internal/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue: "test", body: "msg" }),
      });
      await mock.instance.fetch(req);

      const statsReq = new Request("https://do-queue.internal/stats");
      const statsRes = await mock.instance.fetch(statsReq);
      const stats = await statsRes.json() as { pendingMessages: number };
      expect(stats.pendingMessages).toBe(1);

      block!();
      await Promise.all(mock.waitUntilPromises.splice(0));
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
    // With jitter, we should get varying results
    expect(results.size).toBeGreaterThan(1);
    // All should be >= base (jitter only adds, never subtracts)
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(1000);
      expect(r).toBeLessThanOrEqual(1500); // base + base * 0.5
    }
  });
});
