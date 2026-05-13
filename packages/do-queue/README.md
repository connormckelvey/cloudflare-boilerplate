# @cloudflare-boilerplate/do-queue

A low-latency FIFO message queue built on Cloudflare Durable Objects. It borrows the Cloudflare Queues consumer shape, but keeps strict per-partition FIFO ordering and Durable Object locality instead of trying to be a full replacement for the managed Queues service.

`do-queue` uses Durable Object RPC methods, so your Worker compatibility date must be `2024-04-03` or newer.

## Usage

### Producer

```ts
import { DOQueueProducer } from "@cloudflare-boilerplate/do-queue";

const producer = new DOQueueProducer<MyMessage>(env.MY_QUEUE_DO, "my-queue");
await producer.send({ foo: "bar" });

// Partition by key — messages with the same key share a DO instance and FIFO order
await producer.send({ foo: "bar" }, { key: userId });
```

### Consumer

```ts
import { createDOQueue, type DOQueueNamespace } from "@cloudflare-boilerplate/do-queue";

interface Env {
  MY_QUEUE_DO: DOQueueNamespace<MyMessage, Env>;
}

export const MyQueueDO = createDOQueue<MyMessage, Env>({
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        // message.body, message.id, message.attempts, message.timestamp
        await doWork(message.body, env);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
  async deadLetter(message, error, env) {
    // Called after maxRetries retries are exhausted. Optional.
  },
}, {
  maxRetries: 3,           // default: 3 retries after the first delivery
  maxBatchSize: 10,        // default: 10
  retryBaseDelayMs: 1000,  // default: 1000
  retryMaxDelayMs: 30000,  // default: 30000
  retryJitter: 0.1,        // default: 0.1
});
```

Bind in `wrangler.jsonc`:

```jsonc
{
  "compatibility_date": "2024-04-03",
  "durable_objects": {
    "bindings": [
      { "name": "MY_QUEUE_DO", "class_name": "MyQueueDO" }
    ]
  }
}
```

## Delivery semantics

**At-least-once delivery.** A message is deleted from storage only after it is acknowledged. If the handler throws, the DO crashes, or the runtime evicts the DO mid-processing, unsettled messages remain in storage and will be retried.

This means handlers must be **idempotent** — the same message may be delivered more than once. Use the `message.id` (a stable UUID assigned at enqueue time) for deduplication if your downstream system requires exactly-once effects.

### Batch acknowledgement

`queue(batch, env, ctx)` receives up to `maxBatchSize` messages. Settlement follows Cloudflare Queues' push-consumer model:

- If `queue()` returns successfully and all promises passed to `ctx.waitUntil()` resolve, unsettled messages are implicitly acknowledged.
- If `queue()` throws or a promise passed to `ctx.waitUntil()` rejects, unsettled messages are implicitly retried.
- `message.ack()` marks one message delivered.
- `message.retry({ delaySeconds })` marks one message for retry and can override the configured retry backoff.
- `batch.ackAll()` and `batch.retryAll({ delaySeconds })` settle every message that has not already been settled.
- First settlement wins. A message-level `ack()` or `retry()` is not overwritten by a later batch-level call.

### Retry flow

1. `queue()` throws, `ctx.waitUntil()` rejects, or `retry()` is called → unsettled/retried messages stay in storage
2. If retry budget remains: exponential backoff alarm scheduled, processing pauses at the oldest retained message
3. Alarm fires → processing resumes from the oldest message
4. If a message has already used `maxRetries` retries: `deadLetter()` called (if provided)
   - `deadLetter()` succeeds → message deleted
   - `deadLetter()` throws → message retained in a DLQ handoff state, and only `deadLetter()` is retried with backoff
   - No `deadLetter` handler → message deleted immediately, matching Cloudflare Queues without a configured DLQ

`message.attempts` starts at 1. With `maxRetries: 3`, a message can be delivered up to four times before dead-letter handling.

A 10-second fallback alarm runs whenever messages exist in storage, catching stranded state after unexpected DO eviction.

### DLQ retention

Cloudflare's native DLQ is another queue: after the failed message is written there, that DLQ owns retention and consumption. Messages delivered to a native DLQ without an active consumer persist for four days before deletion.

`do-queue` models `deadLetter()` as the DLQ handoff step, not as a separate persisted queue. If that handoff throws, the original message stays in this Durable Object and only `deadLetter()` is retried with capped backoff. No extra retention window is applied while the handoff is failing, so the message is preserved until the callback succeeds or an operator changes/removes it.

## Cloudflare Queues parity

This package intentionally does not provide full Cloudflare Queues parity. Cloudflare Queues is a distributed managed queue with best-effort ordering, queue-level retention, dashboard/API metrics, producer `sendBatch()`, and real DLQs as separate queues. `do-queue` is a Durable Object-backed FIFO queue optimized for low-latency per-key processing.

## FIFO ordering and head-of-line blocking

Messages within a single DO instance are processed in strict FIFO order. Ordering is guaranteed by a composite storage key: `msg:{timestamp}:{sequence}:{uuid}`. A monotonic sequence counter ensures correct ordering even when multiple messages arrive within the same millisecond.

**Head-of-line blocking:** Because processing is sequential within a DO, a slow or repeatedly-failing message blocks all messages behind it in that partition. This is an inherent tradeoff of strict FIFO — you cannot skip ahead without breaking ordering guarantees.

Mitigations:
- **Partition by key:** Use `producer.send(body, { key })` to shard messages across independent DO instances. Each key gets its own FIFO lane, so a blocked message in one partition doesn't affect others.
- **Keep handlers fast:** Move heavy work (large file downloads, long API calls) out of the critical path where possible.
- **Set reasonable `maxRetries`:** A low retry count with exponential backoff limits how long a poison message can block its partition. After exhausting retries, the message moves to dead letter handling and the queue advances.

### Partition key design

When no key is provided, all messages go to a single DO instance (single FIFO lane). With a key, the DO instance name becomes `{queueName}:{key}`, giving each key its own independent queue. Choose a key that balances ordering requirements against parallelism — for example, a user ID ensures per-user ordering while allowing different users' messages to process concurrently.
