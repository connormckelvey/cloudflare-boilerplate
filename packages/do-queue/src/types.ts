export interface QueueMessage<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  /** Number of delivery attempts, starting at 1. */
  readonly attempts: number;
  /** Library extension: configured retries after the first delivery. */
  readonly maxRetries: number;
  /** Library extension: Unix timestamp in milliseconds. Prefer timestamp for Cloudflare parity. */
  readonly enqueuedAt: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

export interface DeadLetterMessage<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  readonly attempts: number;
  readonly maxRetries: number;
  readonly enqueuedAt: number;
}

export interface QueueOptions {
  /** Max retries after the first delivery before dead-lettering. Default: 3 */
  maxRetries?: number;
  /** Max messages delivered to queue() at once. Default: 10 */
  maxBatchSize?: number;
  /** Base delay in ms for exponential backoff. Default: 1000 */
  retryBaseDelayMs?: number;
  /** Max backoff delay in ms. Default: 30000 */
  retryMaxDelayMs?: number;
  /** Jitter factor 0-1 applied to backoff. Default: 0.1 */
  retryJitter?: number;
}

export interface QueueRetryOptions {
  /** Delay before redelivery. Overrides the configured backoff for this retry. */
  delaySeconds?: number;
}

export interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<T>[];
  ackAll(): void;
  retryAll(options?: QueueRetryOptions): void;
}

export interface QueueExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ConsumerHandler<T = unknown, Env = unknown> {
  queue(
    batch: MessageBatch<T>,
    env: Env,
    ctx: QueueExecutionContext
  ): void | Promise<void>;
  deadLetter?(
    message: DeadLetterMessage<T>,
    lastError: Error,
    env: Env
  ): Promise<void>;
}

export interface EnqueueRequest<T = unknown> {
  queue: string;
  body: T;
}

export interface EnqueueResult {
  messageId: string;
}

export interface QueueStats {
  pendingMessages: number;
}

export interface StoredMessage<T = unknown> {
  id: string;
  queue: string;
  body: T;
  enqueuedAt: number;
  seq: number;
  state?: "ready" | "dead-lettering";
  /** Number of delivery attempts, starting at 0 before first delivery. */
  attempts: number;
  /** Retries after the first delivery. */
  maxRetries: number;
  retryAfter?: number;
  lastError?: string;
  /** Number of times the deadLetter handler itself has failed. */
  dlqAttempts?: number;
}
