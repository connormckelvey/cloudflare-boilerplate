export interface QueueMessage<T = unknown> {
  id: string;
  body: T;
  enqueuedAt: number;
  attempts: number;
  maxRetries: number;
}

export interface QueueOptions {
  /** Max retry attempts before dead-lettering. Default: 3 */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000 */
  retryBaseDelayMs?: number;
  /** Max backoff delay in ms. Default: 30000 */
  retryMaxDelayMs?: number;
  /** Jitter factor 0-1 applied to backoff. Default: 0.1 */
  retryJitter?: number;
}

export interface ConsumerHandler<T = unknown, Env = unknown> {
  process(message: QueueMessage<T>, env: Env): Promise<void>;
  deadLetter?(message: QueueMessage<T>, lastError: Error, env: Env): Promise<void>;
}

export interface StoredMessage<T = unknown> {
  id: string;
  queue: string;
  body: T;
  enqueuedAt: number;
  seq: number;
  state?: "ready" | "dead-lettering";
  attempts: number;
  maxRetries: number;
  retryAfter?: number;
  lastError?: string;
  /** Number of times the deadLetter handler itself has failed. */
  dlqAttempts?: number;
}
