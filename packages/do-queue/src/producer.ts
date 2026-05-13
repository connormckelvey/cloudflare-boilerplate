import type { EnqueueRequest, EnqueueResult, QueueStats } from "./types.js";

export interface SendOptions {
  /** Partition key for sharding across DO instances. Messages with the same key go to the same DO. */
  key?: string;
}

type DOQueueStub<T> = DurableObjectStub & {
  enqueue(input: EnqueueRequest<T>): Promise<EnqueueResult>;
  stats(): Promise<QueueStats>;
};

export class DOQueueProducer<T = unknown> {
  private binding: DurableObjectNamespace;
  private queueName: string;

  constructor(binding: DurableObjectNamespace, queueName: string) {
    this.binding = binding;
    this.queueName = queueName;
  }

  async send(body: T, options?: SendOptions): Promise<{ messageId: string }> {
    const doName = options?.key
      ? `${this.queueName}:${options.key}`
      : this.queueName;
    const id = this.binding.idFromName(doName);
    const stub = this.binding.get(id) as DOQueueStub<T>;

    return stub.enqueue({ queue: this.queueName, body });
  }
}
