import { describe, expect, it } from "vitest";
import { normalizeKafkaBootstrapServers, parseKafkaBootstrapServers, resolveKafkaSecurityProtocol } from "../../connection/kafkaBootstrapServers";

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

  it("accepts IPv6 scope identifiers used by Windows hosts", () => {
    expect(normalizeKafkaBootstrapServers("[fe80::1%12]:9092,[fe80::2%eth0]:9093")).toBe("[fe80::1%12]:9092,[fe80::2%eth0]:9093");
  });

  it("normalizes Kafka listener URIs and exposes the inferred security protocol", () => {
    expect(parseKafkaBootstrapServers("PLAINTEXT://broker1:9092, broker2:9092")).toEqual({
      bootstrapServers: "broker1:9092,broker2:9092",
      inferredSecurityProtocol: "PLAINTEXT",
    });
    expect(parseKafkaBootstrapServers("SASL_SSL://secure-broker:9093")).toEqual({
      bootstrapServers: "secure-broker:9093",
      inferredSecurityProtocol: "SASL_SSL",
    });
    expect(parseKafkaBootstrapServers("SSL://secure-broker:9093").inferredSecurityProtocol).toBe("SSL");
    expect(parseKafkaBootstrapServers("SASL_PLAINTEXT://broker1:9092").inferredSecurityProtocol).toBe("SASL_PLAINTEXT");
  });

  it("rejects bootstrap servers that declare conflicting security protocols", () => {
    expect(() => normalizeKafkaBootstrapServers("SSL://broker1:9093,PLAINTEXT://broker2:9092")).toThrow("Kafka bootstrap servers must use one security protocol");
  });

  it("rejects unknown listener URI schemes", () => {
    expect(() => normalizeKafkaBootstrapServers("INTERNAL://broker1:9092")).toThrow("Kafka bootstrap server protocol is invalid");
  });

  it("uses an inferred protocol only when security remains automatic", () => {
    expect(resolveKafkaSecurityProtocol("", "SASL_SSL")).toBe("SASL_SSL");
    expect(resolveKafkaSecurityProtocol("SSL", "SASL_SSL")).toBe("SSL");
    expect(resolveKafkaSecurityProtocol("", undefined)).toBe("");
  });

  it("rejects invalid bootstrap server values", () => {
    expect(() => normalizeKafkaBootstrapServers("broker1:9092/path,broker2:9092")).toThrow("Kafka bootstrap servers are invalid");
    expect(() => normalizeKafkaBootstrapServers("broker1")).toThrow("Kafka bootstrap servers must be host:port values");
    expect(() => normalizeKafkaBootstrapServers("broker1:0")).toThrow("Kafka bootstrap servers are invalid");
    expect(() => normalizeKafkaBootstrapServers("broker1:70000")).toThrow("Kafka bootstrap servers are invalid");
    expect(() => normalizeKafkaBootstrapServers("broker1:9092?query=x")).toThrow("Kafka bootstrap servers are invalid");
    expect(() => normalizeKafkaBootstrapServers("user:pass@broker1:9092")).toThrow("Kafka bootstrap servers are invalid");
  });
});
