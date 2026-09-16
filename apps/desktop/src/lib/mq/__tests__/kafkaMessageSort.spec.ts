import { describe, expect, it } from "vitest";
import type { PeekedMessage } from "@/types/mq";
import { sortKafkaMessagesByPublishTime } from "@/lib/mq/kafkaMessageSort";

function message(position: number, publishTime?: string): PeekedMessage {
  return {
    position,
    messageId: String(position),
    publishTime,
    payloadBase64: "",
    payloadText: `message ${position}`,
    properties: {},
    headers: {},
  };
}

describe("Kafka message display sorting", () => {
  it("sorts valid timestamps in either direction without mutating the input", () => {
    const messages = [message(1, "1000"), message(2, "3000"), message(3, "2000")];

    expect(sortKafkaMessagesByPublishTime(messages, "newest").map(({ position }) => position)).toEqual([2, 3, 1]);
    expect(sortKafkaMessagesByPublishTime(messages, "oldest").map(({ position }) => position)).toEqual([1, 3, 2]);
    expect(messages.map(({ position }) => position)).toEqual([1, 2, 3]);
  });

  it("keeps equal and unavailable timestamps stable after valid timestamps", () => {
    const messages = [message(1), message(2, "2000"), message(3, "invalid"), message(4, "2000"), message(5, "")];

    expect(sortKafkaMessagesByPublishTime(messages, "newest").map(({ position }) => position)).toEqual([2, 4, 1, 3, 5]);
    expect(sortKafkaMessagesByPublishTime(messages, "oldest").map(({ position }) => position)).toEqual([2, 4, 1, 3, 5]);
  });
});
