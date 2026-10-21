import { describe, expect, it } from "vitest";
import { editableSshLocalPort, normalizeSshLocalPort, sshLocalPortState, sshLocalPortSupportedForConnection, withoutSshLocalPorts, type SshLocalPortState } from "@/lib/connection/sshLocalPort";
import type { ConnectionConfig, TransportLayerConfig } from "@/types/database";

const CASES: { name: string; value: unknown; normalized: number | undefined; state: SshLocalPortState; editable: number | undefined }[] = [
  { name: "lowest port", value: 1, normalized: 1, state: "valid", editable: 1 },
  { name: "typical port", value: 4059, normalized: 4059, state: "valid", editable: 4059 },
  { name: "highest port", value: 65535, normalized: 65535, state: "valid", editable: 65535 },
  { name: "numeric string", value: "4059", normalized: 4059, state: "valid", editable: 4059 },
  { name: "numeric string with spaces", value: " 4059 ", normalized: 4059, state: "valid", editable: 4059 },
  { name: "undefined", value: undefined, normalized: undefined, state: "unset", editable: undefined },
  { name: "null", value: null, normalized: undefined, state: "unset", editable: undefined },
  { name: "empty string", value: "", normalized: undefined, state: "unset", editable: undefined },
  { name: "blank string", value: "   ", normalized: undefined, state: "unset", editable: undefined },
  { name: "zero", value: 0, normalized: undefined, state: "invalid", editable: 0 },
  { name: "zero string", value: "0", normalized: undefined, state: "invalid", editable: 0 },
  { name: "negative", value: -1, normalized: undefined, state: "invalid", editable: -1 },
  { name: "negative string", value: "-1", normalized: undefined, state: "invalid", editable: Number.NaN },
  { name: "above range", value: 65536, normalized: undefined, state: "invalid", editable: 65536 },
  { name: "far above range", value: 70000, normalized: undefined, state: "invalid", editable: 70000 },
  { name: "above range string", value: "70000", normalized: undefined, state: "invalid", editable: 70000 },
  { name: "fraction", value: 4059.5, normalized: undefined, state: "invalid", editable: 4059.5 },
  { name: "fraction string", value: "4059.5", normalized: undefined, state: "invalid", editable: Number.NaN },
  { name: "NaN", value: Number.NaN, normalized: undefined, state: "invalid", editable: Number.NaN },
  { name: "Infinity", value: Number.POSITIVE_INFINITY, normalized: undefined, state: "invalid", editable: Number.POSITIVE_INFINITY },
  { name: "hex string", value: "0x10", normalized: undefined, state: "invalid", editable: Number.NaN },
  { name: "text", value: "abc", normalized: undefined, state: "invalid", editable: Number.NaN },
  { name: "boolean", value: true, normalized: undefined, state: "invalid", editable: Number.NaN },
];

describe("ssh local port helpers", () => {
  it.each(CASES)("normalizes $name", ({ value, normalized }) => {
    expect(normalizeSshLocalPort(value)).toBe(normalized);
  });

  it.each(CASES)("classifies $name", ({ value, state }) => {
    expect(sshLocalPortState(value)).toBe(state);
  });

  it.each(CASES)("keeps $name reportable in the form", ({ value, editable }) => {
    expect(editableSshLocalPort(value)).toBe(editable);
  });

  it("keeps an out-of-range value classified as invalid after the form round trip", () => {
    expect(sshLocalPortState(editableSshLocalPort("70000"))).toBe("invalid");
    expect(sshLocalPortState(editableSshLocalPort("abc"))).toBe("invalid");
    expect(sshLocalPortState(editableSshLocalPort(""))).toBe("unset");
  });
});

describe("sshLocalPortSupportedForConnection", () => {
  type Connection = Parameters<typeof sshLocalPortSupportedForConnection>[0];
  const CASES: { name: string; config: Connection; mqSystemKind?: string; supported: boolean }[] = [
    { name: "postgres", config: { db_type: "postgres" }, supported: true },
    { name: "mysql", config: { db_type: "mysql" }, supported: true },
    { name: "redis without a mode", config: { db_type: "redis" }, supported: true },
    { name: "redis standalone", config: { db_type: "redis", redis_connection_mode: "standalone" }, supported: true },
    { name: "redis cluster", config: { db_type: "redis", redis_connection_mode: "cluster" }, supported: false },
    { name: "redis sentinel", config: { db_type: "redis", redis_connection_mode: "sentinel" }, supported: false },
    { name: "a redis mode left on another database type", config: { db_type: "postgres", redis_connection_mode: "cluster" }, supported: true },
    { name: "sqlite over ssh", config: { db_type: "sqlite" }, supported: false },
    { name: "clickhouse", config: { db_type: "clickhouse" }, supported: false },
    { name: "turso", config: { db_type: "turso" }, supported: false },
    { name: "cloudflare d1", config: { db_type: "cloudflare-d1" }, supported: false },
    { name: "rocketmq by driver profile", config: { db_type: "mq", driver_profile: "rocketmq" }, supported: false },
    { name: "rocketmq by saved admin config", config: { db_type: "mq", external_config: { systemKind: "rocketmq" } }, supported: false },
    { name: "kafka", config: { db_type: "mq", driver_profile: "kafka", external_config: { systemKind: "kafka" } }, supported: true },
    { name: "rabbitmq", config: { db_type: "mq", driver_profile: "rabbitmq" }, supported: true },
    { name: "pulsar", config: { db_type: "mq", driver_profile: "pulsar" }, supported: true },
    { name: "saved admin kind wins over a stale driver profile", config: { db_type: "mq", driver_profile: "pulsar", external_config: { systemKind: "rocketmq" } }, supported: false },
    { name: "rocketmq picked in the form", config: { db_type: "mq", driver_profile: "kafka", external_config: { systemKind: "kafka" } }, mqSystemKind: "rocketmq", supported: false },
    { name: "kafka picked in the form over a saved rocketmq kind", config: { db_type: "mq", driver_profile: "rocketmq", external_config: { systemKind: "rocketmq" } }, mqSystemKind: "kafka", supported: true },
    { name: "form kind ignored for other database types", config: { db_type: "postgres" }, mqSystemKind: "rocketmq", supported: true },
  ];

  it.each(CASES)("reports $name as supported: $supported", ({ config, mqSystemKind, supported }) => {
    expect(sshLocalPortSupportedForConnection(config, mqSystemKind)).toBe(supported);
  });
});

describe("withoutSshLocalPorts", () => {
  const ssh = (id: string, localPort?: number): TransportLayerConfig => ({ type: "ssh", id, host: `${id}.example.com`, port: 22, user: "root", ...(localPort === undefined ? {} : { local_port: localPort }) });
  const proxy: TransportLayerConfig = { type: "proxy", id: "proxy", proxy_type: "socks5", host: "proxy.example.com", port: 1080 };
  const http: TransportLayerConfig = { type: "http_tunnel", id: "http", url: "https://tunnel.example.com", token: "", protocol: "dbx_tcp" };
  const config = (layers?: TransportLayerConfig[]): ConnectionConfig => ({ id: "c", name: "C", db_type: "postgres", host: "db", port: 5432, username: "u", password: "p", transport_layers: layers });

  it("drops the fixed port from every ssh layer and leaves other layers untouched", () => {
    const layers = [http, ssh("a", 4059), proxy, ssh("b", 4060), ssh("c")];
    const copy = withoutSshLocalPorts(config(layers));

    expect(copy.transport_layers?.map((layer) => layer.id)).toEqual(["http", "a", "proxy", "b", "c"]);
    for (const layer of copy.transport_layers ?? []) expect(layer).not.toHaveProperty("local_port");
    expect(copy.transport_layers?.[0]).toBe(http);
    expect(copy.transport_layers?.[2]).toBe(proxy);
    expect(copy.transport_layers?.[1]).toMatchObject({ type: "ssh", id: "a", host: "a.example.com", port: 22, user: "root" });
  });

  it("does not mutate its input", () => {
    const original = config([ssh("a", 4059)]);
    const copy = withoutSshLocalPorts(original);

    expect(copy).not.toBe(original);
    expect(original.transport_layers?.[0]).toMatchObject({ local_port: 4059 });
  });

  it("keeps the rest of the config and tolerates a missing layer list", () => {
    const copy = withoutSshLocalPorts(config());

    expect(copy).toEqual(config());
    expect(copy).not.toBe(config());
    expect(withoutSshLocalPorts({ ...config([]), name: "Renamed" })).toMatchObject({ name: "Renamed", transport_layers: [] });
  });
});
