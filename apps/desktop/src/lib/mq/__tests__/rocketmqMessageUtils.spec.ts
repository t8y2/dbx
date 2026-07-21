import { describe, expect, it } from "vitest";
import type { PeekedMessage } from "@/types/mq";
import { rocketMqDisplayFromPeeked } from "@/lib/mq/rocketmqMessageUtils";

describe("rocketMqDisplayFromPeeked", () => {
  it("maps RocketMQ peek fields including msgId, tag and queue offset", () => {
    const peeked: PeekedMessage = {
      position: 1,
      messageId: "0BC16699165C03B925DB8A404E2D****",
      key: "order-1",
      publishTime: "1710000000000",
      properties: {
        partition: "2",
        offset: "15",
        tag: "cs-pt-dlq-test",
      },
      headers: {},
      payloadBase64: "",
      payloadText: "dlq message",
    };

    expect(rocketMqDisplayFromPeeked(peeked, "%DLQ%cs-pt-test-group")).toEqual({
      messageId: "0BC16699165C03B925DB8A404E2D****",
      partition: 2,
      offset: 15,
      key: "order-1",
      tag: "cs-pt-dlq-test",
      timestamp: 1710000000000,
      payloadText: "dlq message",
      payloadBase64: "",
      headers: {},
      topic: "%DLQ%cs-pt-test-group",
    });
  });

  it("falls back to TAGS header when tag property is missing", () => {
    const peeked: PeekedMessage = {
      position: 1,
      messageId: "abc",
      properties: {},
      headers: { TAGS: "fallback-tag" },
      payloadBase64: "",
    };

    expect(rocketMqDisplayFromPeeked(peeked).tag).toBe("fallback-tag");
  });
});
