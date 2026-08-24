import { describe, expect, it } from "vitest";
import type { PeekedMessage } from "@/types/mq";
import { buildKafkaMessageSearchText, kafkaMessageSearchTextMatches, normalizeKafkaMessageSearchQuery } from "@/lib/mq/kafkaMessageSearch";

function message(overrides: Partial<PeekedMessage> = {}): PeekedMessage {
  return {
    position: 7,
    messageId: "42",
    key: "Order-ABC",
    publishTime: "1724457600000",
    properties: { partition: "3" },
    headers: { TraceId: "REQUEST-99", source: "billing" },
    payloadBase64: "",
    payloadText: '{"customer":"Alice"}',
    ...overrides,
  };
}

describe("Kafka loaded message search", () => {
  it("builds a case-insensitive index from every visible message field", () => {
    const searchText = buildKafkaMessageSearchText(message(), "8/24/2024, 8:00:00 AM");

    for (const query of ["7", "42", "order-abc", "3", "1724457600000", "8:00:00 am", "traceid", "request-99", "billing", "alice"]) {
      expect(kafkaMessageSearchTextMatches(searchText, normalizeKafkaMessageSearchQuery(query)), query).toBe(true);
    }
  });

  it("uses the displayed Base64 payload when text is unavailable", () => {
    const searchText = buildKafkaMessageSearchText(
      message({
        payloadText: undefined,
        payloadBase64: "AAECAw==",
      }),
    );

    expect(kafkaMessageSearchTextMatches(searchText, normalizeKafkaMessageSearchQuery("aecaw=="))).toBe(true);
  });

  it("treats whitespace-only queries as empty and rejects missing text", () => {
    const searchText = buildKafkaMessageSearchText(message());

    expect(kafkaMessageSearchTextMatches(searchText, normalizeKafkaMessageSearchQuery("   "))).toBe(true);
    expect(kafkaMessageSearchTextMatches(searchText, normalizeKafkaMessageSearchQuery("not-present"))).toBe(false);
  });
});
