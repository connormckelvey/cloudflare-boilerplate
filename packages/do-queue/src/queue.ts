import { DurableObject } from "cloudflare:workers";
import type {
  QueueMessage,
  QueueOptions,
  ConsumerHandler,
  DeadLetterMessage,
  EnqueueRequest,
  EnqueueResult,
  MessageBatch,
  QueueStats,
  QueueRetryOptions,
  StoredMessage,
} from "./types.js";
import { computeBackoff } from "./retry.js";

const FALLBACK_ALARM_MS = 10_000;
const SEQ_KEY = "meta:seq";

export type DOQueueInstance<T = unknown, Env = unknown> = DurableObject<Env> & {
  enqueue(input: EnqueueRequest<T>): Promise<EnqueueResult>;
  stats(): Promise<QueueStats>;
  alarm(): Promise<void>;
};

export type DOQueueClass<T = unknown, Env = unknown> = new (
  ctx: DurableObjectState,
  env: Env
) => DOQueueInstance<T, Env>;

export type DOQueueNamespace<T = unknown, Env = unknown> =
  DurableObjectNamespace<DOQueueInstance<T, Env>>;

type Settlement =
  | { type: "ack" }
  | { type: "retry"; delaySeconds?: number; error?: Error };

interface BatchItem<T> {
  key: string;
  msg: StoredMessage<T>;
  settlement?: Settlement;
}

export function createDOQueue<T = unknown, Env = unknown>(
  handler: ConsumerHandler<T, Env>,
  options?: QueueOptions
): DOQueueClass<T, Env> {
  const maxRetries = options?.maxRetries ?? 3;
  const maxBatchSize = Math.max(1, Math.floor(options?.maxBatchSize ?? 10));
  const retryBaseDelayMs = options?.retryBaseDelayMs ?? 1000;
  const retryMaxDelayMs = options?.retryMaxDelayMs ?? 30000;
  const retryJitter = options?.retryJitter ?? 0.1;

  return class DOQueueImpl extends DurableObject<Env> {
    #processing = false;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
    }

    async enqueue({ queue, body }: EnqueueRequest<T>): Promise<EnqueueResult> {
      const id = crypto.randomUUID();
      const enqueuedAt = Date.now();

      await this.ctx.storage.transaction(async (txn) => {
        // Monotonic sequence counter ensures FIFO even within the same millisecond.
        const prevSeq = (await txn.get<number>(SEQ_KEY)) ?? 0;
        const seq = prevSeq + 1;

        const msg: StoredMessage<T> = {
          id,
          queue,
          body,
          enqueuedAt,
          seq,
          attempts: 0,
          maxRetries,
        };

        const key = `msg:${String(enqueuedAt).padStart(15, "0")}:${String(seq).padStart(10, "0")}:${id}`;
        await txn.put(SEQ_KEY, seq);
        await txn.put(key, msg);
      });

      // Trigger immediate processing if not already running
      if (!this.#processing) {
        this.ctx.waitUntil(this.#processNext());
      }

      return { messageId: id };
    }

    async #processNext(): Promise<void> {
      if (this.#processing) return;
      this.#processing = true;
      let retryAlarmSet = false;

      try {
        while (true) {
          const entries = await this.ctx.storage.list<StoredMessage<T>>({
            prefix: "msg:",
            limit: maxBatchSize,
          });

          if (entries.size === 0) break;

          const first = entries.entries().next().value as
            | [string, StoredMessage<T>]
            | undefined;
          if (!first) break;

          const [firstKey, firstMsg] = first;

          // Strict FIFO: if the head message is cooling down, everything behind it waits.
          if (firstMsg.retryAfter && Date.now() < firstMsg.retryAfter) {
            await this.ctx.storage.setAlarm(firstMsg.retryAfter);
            retryAlarmSet = true;
            return;
          }

          if (firstMsg.state === "dead-lettering") {
            const handedOff = await this.#attemptDeadLetter(firstKey, firstMsg);
            if (!handedOff) {
              retryAlarmSet = true;
              return;
            }
            continue;
          }

          const batchItems: BatchItem<T>[] = [];
          for (const [key, msg] of entries) {
            if (msg.state === "dead-lettering") break;
            if (msg.retryAfter && Date.now() < msg.retryAfter) break;

            msg.attempts++;
            delete msg.retryAfter;
            await this.ctx.storage.put(key, msg);
            batchItems.push({ key, msg });
          }

          if (batchItems.length === 0) continue;

          const blockedUntil = await this.#deliverBatch(batchItems);
          if (blockedUntil && blockedUntil > Date.now()) {
            await this.ctx.storage.setAlarm(blockedUntil);
            retryAlarmSet = true;
            return;
          }
        }
      } finally {
        this.#processing = false;

        // Safety: set fallback alarm if messages remain (catches stranded state after DO eviction).
        // Skip if a retry alarm was already set so we don't overwrite a precise retry time.
        if (!retryAlarmSet) {
          const remaining = await this.ctx.storage.list({
            prefix: "msg:",
            limit: 1,
          });
          if (remaining.size > 0) {
            await this.ctx.storage.setAlarm(Date.now() + FALLBACK_ALARM_MS);
          }
        }
      }
    }

    async #deliverBatch(items: BatchItem<T>[]): Promise<number | null> {
      const waitUntilPromises: Promise<unknown>[] = [];
      const queue = items[0]?.msg.queue ?? "";

      const settle = (item: BatchItem<T>, settlement: Settlement) => {
        if (!item.settlement) {
          item.settlement = settlement;
        }
      };

      const messages = items.map((item): QueueMessage<T> => ({
        id: item.msg.id,
        timestamp: new Date(item.msg.enqueuedAt),
        body: item.msg.body,
        attempts: item.msg.attempts,
        maxRetries: item.msg.maxRetries,
        enqueuedAt: item.msg.enqueuedAt,
        ack: () => settle(item, { type: "ack" }),
        retry: (retryOptions?: QueueRetryOptions) =>
          settle(item, {
            type: "retry",
            delaySeconds: retryOptions?.delaySeconds,
            error: new Error("Message retry requested"),
          }),
      }));

      const batch: MessageBatch<T> = {
        queue,
        messages,
        ackAll: () => {
          for (const item of items) {
            settle(item, { type: "ack" });
          }
        },
        retryAll: (retryOptions?: QueueRetryOptions) => {
          for (const item of items) {
            settle(item, {
              type: "retry",
              delaySeconds: retryOptions?.delaySeconds,
              error: new Error("Batch retry requested"),
            });
          }
        },
      };

      let handlerError: Error | null = null;
      try {
        await handler.queue(batch, this.env, {
          waitUntil: (promise) => {
            waitUntilPromises.push(promise);
            this.ctx.waitUntil(promise.catch(() => undefined));
          },
        });
        await Promise.all(waitUntilPromises);
      } catch (error) {
        handlerError =
          error instanceof Error ? error : new Error(String(error));
      }

      for (const item of items) {
        if (!item.settlement) {
          item.settlement = handlerError
            ? { type: "retry", error: handlerError }
            : { type: "ack" };
        }
      }

      let blockedUntil: number | null = null;
      for (const item of items) {
        if (item.settlement?.type === "ack") {
          await this.ctx.storage.delete(item.key);
          continue;
        }

        const retryBlockedUntil = await this.#retryOrDeadLetter(
          item.key,
          item.msg,
          item.settlement?.error ??
            new Error("Message processing failed"),
          item.settlement?.delaySeconds
        );
        if (retryBlockedUntil && (!blockedUntil || retryBlockedUntil < blockedUntil)) {
          blockedUntil = retryBlockedUntil;
        }
      }

      return blockedUntil;
    }

    async #retryOrDeadLetter(
      key: string,
      msg: StoredMessage<T>,
      error: Error,
      delaySeconds?: number
    ): Promise<number | null> {
      msg.lastError = error.message;

      if (msg.attempts > msg.maxRetries) {
        if (!handler.deadLetter) {
          // No DLQ configured: match Cloudflare Queues and discard after retries.
          await this.ctx.storage.delete(key);
          return null;
        }

        msg.state = "dead-lettering";
        delete msg.retryAfter;
        const handedOff = await this.#attemptDeadLetter(key, msg, error);
        return handedOff ? null : msg.retryAfter ?? Date.now() + FALLBACK_ALARM_MS;
      }

      const delay =
        delaySeconds === undefined
          ? computeBackoff(
              msg.attempts,
              retryBaseDelayMs,
              retryMaxDelayMs,
              retryJitter
            )
          : Math.max(0, delaySeconds) * 1000;
      msg.retryAfter = Date.now() + delay;
      await this.ctx.storage.put(key, msg);
      return msg.retryAfter;
    }

    async #attemptDeadLetter(
      key: string,
      msg: StoredMessage<T>,
      error = new Error(msg.lastError ?? "Message processing failed")
    ): Promise<boolean> {
      if (!handler.deadLetter) {
        await this.ctx.storage.delete(key);
        return true;
      }

      const deadLetterMessage: DeadLetterMessage<T> = {
        id: msg.id,
        timestamp: new Date(msg.enqueuedAt),
        body: msg.body,
        enqueuedAt: msg.enqueuedAt,
        attempts: msg.attempts,
        maxRetries: msg.maxRetries,
      };

      try {
        await handler.deadLetter(deadLetterMessage, error, this.env);
        await this.ctx.storage.delete(key);
        return true;
      } catch (dlqError) {
        console.error("do-queue: dead letter handler failed:", dlqError);

        msg.state = "dead-lettering";
        msg.dlqAttempts = (msg.dlqAttempts ?? 0) + 1;
        const delay = computeBackoff(
          msg.dlqAttempts,
          retryBaseDelayMs,
          retryMaxDelayMs,
          retryJitter
        );
        msg.retryAfter = Date.now() + delay;
        await this.ctx.storage.put(key, msg);
        await this.ctx.storage.setAlarm(msg.retryAfter);
        return false;
      }
    }

    async alarm(): Promise<void> {
      await this.#processNext();
    }

    async stats(): Promise<QueueStats> {
      const entries = await this.ctx.storage.list({ prefix: "msg:" });
      return { pendingMessages: entries.size };
    }
  };
}
