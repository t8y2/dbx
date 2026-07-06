import { describe, expect, it } from "vitest";
import { normalizeKafkaBootstrapServers } from "@/lib/connection/kafkaBootstrapServers";

describe("Kafka bootstrap servers", () => {
  it("keeps comma-separated bootstrap servers", () => {
    expect(normalizeKafkaBootstrapServers("broker1:9092, broker2:9092")).toBe("broker1:9092,broker2:9092");
  });

  it("normalizes common cluster address separators to commas", () => {
    expect(normalizeKafkaBootstrapServers("broker1:9092；broker2:9092，broker3:9092\nbroker4:9092 broker5:9092")).toBe("broker1:9092,broker2:9092,broker3:9092,broker4:9092,broker5:9092");
  });

  it("keeps IPv6 bootstrap servers", () => {
    expect(normalizeKafkaBootstrapServers("[::1]:9092;[2001:db8::1]:9092")).toBe("[::1]:9092,[2001:db8::1]:9092");
  });

  it("rejects bootstrap servers with URL schemes", () => {
    expect(() => normalizeKafkaBootstrapServers("PLAINTEXT://broker1:9092,broker2:9092")).toThrow("Kafka bootstrap servers must be host:port values without a URL scheme");
  });

  it("rejects invalid bootstrap server values", () => {
    expect(() => normalizeKafkaBootstrapServers("broker1:9092/path,broker2:9092")).toThrow("Kafka bootstrap servers are invalid");
  });
});
