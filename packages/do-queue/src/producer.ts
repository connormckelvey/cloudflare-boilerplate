export interface SendOptions {
  /** Partition key for sharding across DO instances. Messages with the same key go to the same DO. */
  key?: string;
}

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
    const stub = this.binding.get(id);

    const response = await stub.fetch("https://do-queue.internal/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queue: this.queueName, body }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`do-queue enqueue failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<{ messageId: string }>;
  }
}
