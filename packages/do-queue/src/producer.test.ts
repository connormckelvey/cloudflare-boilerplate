import { describe, expect, it, vi } from "vitest";
import { DOQueueProducer } from "./producer";

function createBinding(enqueue = vi.fn()) {
  const id = { toString: () => "id", equals: () => true };
  const get = vi.fn(() => ({ enqueue }));
  const idFromName = vi.fn(() => id);

  return {
    binding: { idFromName, get } as unknown as DurableObjectNamespace,
    enqueue,
    get,
    idFromName,
  };
}

describe("DOQueueProducer", () => {
  it("sends messages through the enqueue RPC method", async () => {
    const { binding, enqueue, idFromName } = createBinding(
      vi.fn().mockResolvedValue({ messageId: "msg-1" })
    );
    const producer = new DOQueueProducer<{ foo: string }>(binding, "emails");

    const result = await producer.send({ foo: "bar" });

    expect(idFromName).toHaveBeenCalledWith("emails");
    expect(enqueue).toHaveBeenCalledWith({
      queue: "emails",
      body: { foo: "bar" },
    });
    expect(result).toEqual({ messageId: "msg-1" });
  });

  it("uses the partition key in the Durable Object name", async () => {
    const { binding, idFromName } = createBinding(
      vi.fn().mockResolvedValue({ messageId: "msg-2" })
    );
    const producer = new DOQueueProducer<string>(binding, "sms");

    await producer.send("hello", { key: "user-123" });

    expect(idFromName).toHaveBeenCalledWith("sms:user-123");
  });
});
