import { DurableObject } from "cloudflare:workers";
import type {
  QueueMessage,
  QueueOptions,
  ConsumerHandler,
  EnqueueRequest,
  EnqueueResult,
  QueueStats,
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

export function createDOQueue<T = unknown, Env = unknown>(
  handler: ConsumerHandler<T, Env>,
  options?: QueueOptions
): DOQueueClass<T, Env> {
  const maxRetries = options?.maxRetries ?? 3;
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
            limit: 1,
          });

          if (entries.size === 0) break;

          const [key, msg] = entries.entries().next().value!;

          // Check if message is in retry backoff (applies to both process retries and DLQ retries)
          if (msg.retryAfter && Date.now() < msg.retryAfter) {
            await this.ctx.storage.setAlarm(msg.retryAfter);
            retryAlarmSet = true;
            return;
          }

          if (msg.state === "dead-lettering") {
            const handedOff = await this.#attemptDeadLetter(key, msg);
            if (!handedOff) {
              retryAlarmSet = true;
              return;
            }
            continue;
          }

          msg.attempts++;

          const queueMessage: QueueMessage<T> = {
            id: msg.id,
            body: msg.body,
            enqueuedAt: msg.enqueuedAt,
            attempts: msg.attempts,
            maxRetries: msg.maxRetries,
          };

          try {
            await handler.process(queueMessage, this.env);

            // Success: delete the message
            await this.ctx.storage.delete(key);
          } catch (error) {
            const err =
              error instanceof Error ? error : new Error(String(error));
            msg.lastError = err.message;

            if (msg.attempts >= msg.maxRetries) {
              if (!handler.deadLetter) {
                // No DLQ configured: match Cloudflare Queues and discard after retries.
                await this.ctx.storage.delete(key);
                continue;
              }

              msg.state = "dead-lettering";
              const handedOff = await this.#attemptDeadLetter(key, msg, err);
              if (!handedOff) {
                retryAlarmSet = true;
                return;
              }
            } else {
              // Retry: update message with backoff timestamp
              const delay = computeBackoff(
                msg.attempts,
                retryBaseDelayMs,
                retryMaxDelayMs,
                retryJitter
              );
              msg.retryAfter = Date.now() + delay;
              await this.ctx.storage.put(key, msg);
              await this.ctx.storage.setAlarm(msg.retryAfter);
              retryAlarmSet = true;
              return; // Stop loop; alarm will resume
            }
          }
        }
      } finally {
        this.#processing = false;

        // Safety: set fallback alarm if messages remain (catches stranded state after DO eviction)
        // Skip if a retry alarm was already set — don't overwrite it
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

    async #attemptDeadLetter(
      key: string,
      msg: StoredMessage<T>,
      error = new Error(msg.lastError ?? "Message processing failed")
    ): Promise<boolean> {
      if (!handler.deadLetter) {
        await this.ctx.storage.delete(key);
        return true;
      }

      const queueMessage: QueueMessage<T> = {
        id: msg.id,
        body: msg.body,
        enqueuedAt: msg.enqueuedAt,
        attempts: msg.attempts,
        maxRetries: msg.maxRetries,
      };

      try {
        await handler.deadLetter(queueMessage, error, this.env);
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
