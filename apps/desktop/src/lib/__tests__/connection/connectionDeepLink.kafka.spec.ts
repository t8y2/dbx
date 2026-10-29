import { describe, expect, it } from "vitest";
import { parseConnectionDeepLink } from "@/lib/connection/connectionDeepLink";

function parse(fields: Record<string, string>) {
  return parseConnectionDeepLink(`dbx://connection/new?${new URLSearchParams({ v: "1", type: "kafka", ...fields })}`)!;
}

describe("Kafka connection deep links", () => {
  it("uses the existing MQ Kafka profile and defaults", () => {
    expect(parse({ name: "Example Kafka" })).toEqual({
      name: "Example Kafka",
      dbType: "mq",
      driverProfile: "kafka",
      driverLabel: "Apache Kafka",
      host: "127.0.0.1",
      port: 9092,
      ssl: false,
      mqConfig: { systemKind: "kafka", adminUrl: "", auth: { kind: "none" }, extra: { bootstrapServers: "127.0.0.1:9092", securityProtocol: "PLAINTEXT" } },
    });
  });
  it("accepts host/port and bracketed or bare IPv6 hosts", () => {
    for (const host of ["broker.example.com", "::1", "[::1]"]) {
      const draft = parse({ host, port: "19092" });
      expect(draft.host).toBe(host.replace(/^\[|\]$/g, ""));
      expect(draft.port).toBe(19092);
    }
  });
  it("preserves all brokers and maps the first endpoint to host/port", () => {
    const draft = parse({ bootstrap_servers: "broker-a.example.com:9092; [2001:db8::1]:19092", one_time: "true" });
    expect(draft).toMatchObject({ host: "broker-a.example.com", port: 9092, oneTime: true, mqConfig: { extra: { bootstrapServers: "broker-a.example.com:9092,[2001:db8::1]:19092" } } });
  });
  it("preserves SASL credential whitespace and maps SCRAM plus TLS", () => {
    const draft = parse({ bootstrap_servers: "broker.example.com:9093", security_protocol: "sasl_ssl", sasl_mechanism: "scram-sha-512", user: " user ", password: " +& secret ", ssl: "true" });
    expect(draft.ssl).toBe(true);
    expect(draft.mqConfig).toMatchObject({ auth: { kind: "basic", username: " user ", password: " +& secret " }, extra: { securityProtocol: "SASL_SSL", saslMechanism: "SCRAM-SHA-512" } });
  });
  it("infers SASL from username and permits a password to be entered in DBX", () => {
    expect(parse({ user: "app" }).mqConfig).toMatchObject({ auth: { kind: "basic", username: "app", password: "" }, extra: { securityProtocol: "SASL_PLAINTEXT", saslMechanism: "PLAIN" } });
  });
  it("uses SSL from the bootstrap prefix without downgrading it", () => {
    expect(parse({ bootstrap_servers: "SSL://broker.example.com:9093" })).toMatchObject({ ssl: true, mqConfig: { extra: { securityProtocol: "SSL", bootstrapServers: "broker.example.com:9093" } } });
  });
  it.each([
    { bootstrap_servers: "" },
    { bootstrap_servers: "broker.example.com" },
    { bootstrap_servers: "broker.example.com:65536" },
    { host: "broker.example.com/path" },
    { port: "0" },
    { ssl: "invalid" },
    { password: "secret" },
    { bootstrap_servers: "a:9092", host: "b" },
    { security_protocol: "INVALID" },
    { sasl_mechanism: "GSSAPI" },
    { security_protocol: "PLAINTEXT", user: "app" },
    { security_protocol: "SSL", ssl: "false" },
    { bootstrap_servers: "SSL://a:9093", security_protocol: "PLAINTEXT" },
    { bootstrap_servers: "SSL://a:9093,SASL_SSL://b:9093" },
    { url: "kafka://broker.example.com:9092" },
    { zookeeper_servers: "zk:2181" },
    { name: "x".repeat(4097) },
  ])("rejects invalid or unsupported input: %j", (fields) => {
    expect(() => parse(fields)).toThrow();
  });
  it("rejects duplicate Kafka parameters and unsupported versions", () => {
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=kafka&bootstrap_servers=a:9092&bootstrap_servers=b:9092")).toThrow(/Duplicate/);
    expect(() => parse({ v: "2" })).toThrow(/version/);
  });
});
