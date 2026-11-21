import { describe, expect, it } from "vitest";
import { parseAnotherRedisImport } from "@/lib/imports/anotherRedisImport";
import { selectConnectionConfigBundle, prepareConnectionConfigImport } from "@/lib/connection/connectionConfigTransfer";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const parse = (value: unknown) => parseAnotherRedisImport(encode(value));

describe("Another Redis Desktop Manager .ano import", () => {
  it("handles large valid Base64 without recursive regular-expression matching and enforces count limits", () => {
    const password = "s".repeat(500000);
    expect(parse([{ host: "cache", auth: password }]).connections[0]!.password).toBe(password);
    expect(() => parse(Array.from({ length: 10001 }, () => ({ host: "cache" })))).toThrow("connections/groups");
    expect(() => parse([{ host: "cache", sshOptions: { host: "jump", username: "user", timeout: true } }])).toThrow("SSH timeout");
  });
  it("decodes official UTF-8 Base64 exports and preserves credentials without reusing identities", () => {
    const data = [{ host: " localhost ", port: "6380", name: "开发 Redis", username: " acl ", auth: " 密码 ", key: "runtime-id", db: 4 }];
    const first = parse(data).connections[0]!;
    expect(first).toMatchObject({ name: "开发 Redis", host: "localhost", port: 6380, username: " acl ", password: " 密码 ", db_type: "redis", redis_connection_mode: "standalone", ssl: false });
    expect(first.id).not.toBe("runtime-id");
    expect(parse(data).connections[0]!.id).not.toBe(first.id);
    expect(first).not.toHaveProperty("database");
    expect(data[0]!.key).toBe("runtime-id");
    expect(
      parseAnotherRedisImport(
        `\ufeff${encode(data)
          .match(/.{1,60}/g)!
          .join("\n")}\n`,
      ).connections[0]!.name,
    ).toBe("开发 Redis");
  });

  it("preserves flat group order, duplicate names and dangling memberships as ungrouped", () => {
    const result = parse({
      groups: [
        { id: "one", name: "Prod/EU" },
        { id: "two", name: "Prod/EU" },
      ],
      connections: [
        { host: "first", groupId: "two" },
        { host: "second", groupId: "one" },
        { host: "root", groupId: "missing" },
      ],
    });
    expect(result.layout!.groups.map((g) => g.name)).toEqual(["Prod/EU", "Prod/EU"]);
    expect(result.layout!.order).toEqual([
      { type: "group", id: result.layout!.groups[0]!.id, children: [{ type: "connection", id: result.connections[1]!.id }] },
      { type: "group", id: result.layout!.groups[1]!.id, children: [{ type: "connection", id: result.connections[0]!.id }] },
      { type: "connection", id: result.connections[2]!.id },
    ]);
    const selected = selectConnectionConfigBundle(result, [result.connections[0]!.id]);
    const imported = prepareConnectionConfigImport(selected, [], [], () => crypto.randomUUID());
    expect(imported.connections).toHaveLength(1);
    expect(JSON.stringify(imported.layout)).not.toContain(result.connections[1]!.id);
  });

  it("maps SSH key/passphrase, TLS file paths and read-only safety", () => {
    const config = parse([
      {
        host: "cache",
        connectionReadOnly: true,
        separator: "::",
        sslOptions: { ca: "/ca.pem", cert: "/client.pem", key: "/client.key", servername: "" },
        sshOptions: { host: "bastion", port: "2222", username: "operator", password: " ssh-password ", privatekey: "/id_ed25519", passphrase: " key-password ", timeout: 45 },
      },
    ]).connections[0]!;
    expect(config).toMatchObject({
      ssl: true,
      ca_cert_path: "/ca.pem",
      client_cert_path: "/client.pem",
      client_key_path: "/client.key",
      read_only: true,
      redis_key_separator: "::",
      transport_layers: [{ type: "ssh", host: "bastion", port: 2222, user: "operator", password: " ssh-password ", key_path: "/id_ed25519", key_passphrase: " key-password ", auth_method: "key+password", connect_timeout_secs: 45 }],
    });
  });

  it("distinguishes Sentinel and Redis node authentication and imports IPv6 cluster seeds", () => {
    const sentinel = parse([{ host: "sentinel", port: 26379, username: "node-user", auth: "sentinel-password", sentinelOptions: { masterName: "mymaster", nodePassword: "node-password" } }]).connections[0]!;
    expect(sentinel).toMatchObject({ redis_connection_mode: "sentinel", redis_sentinel_nodes: "sentinel:26379", redis_sentinel_master: "mymaster", redis_sentinel_password: "sentinel-password", password: "node-password", username: "node-user" });
    expect(parse([{ host: "::1", cluster: true }]).connections[0]).toMatchObject({ redis_connection_mode: "cluster", redis_cluster_nodes: "[::1]:6379" });
  });

  it.each([
    null,
    {},
    [],
    [null],
    [{ name: "missing host" }],
    [{ host: "cache", port: -1 }],
    [{ host: "cache", port: 65536 }],
    [{ host: "cache", cluster: "false" }],
    [{ host: "cache", sentinelOptions: {} }],
    [{ host: "cache", cluster: true, sentinelOptions: { masterName: "m" } }],
    [{ host: "cache", sslOptions: { cert: "/cert.pem" } }],
    [{ host: "cache", sslOptions: { servername: "other-host" } }],
    [{ host: "cache", natMap: { source: "target" } }],
    [{ host: "cache", sshOptions: { host: "jump" } }],
    {
      connections: [{ host: "cache" }],
      groups: [
        { id: "g", name: "a" },
        { id: "g", name: "b" },
      ],
    },
  ])("rejects invalid/unsupported configurations before writing %#", (value) => {
    expect(() => parse(value)).toThrow(/Another Redis/);
  });

  it("rejects malformed/oversized exports without exposing credentials", () => {
    for (const raw of ["not-an-ano-file!", "e30", "", "////", Buffer.from("not-json secret-password").toString("base64"), "A".repeat(16 * 1024 * 1024 + 1)]) {
      expect(() => parseAnotherRedisImport(raw)).toThrow(/Another Redis/);
      try {
        parseAnotherRedisImport(raw);
      } catch (error) {
        expect(String(error)).not.toContain("secret-password");
      }
    }
    expect(() => parse([{ host: "valid" }, { host: "invalid", port: false, auth: "secret-password" }])).toThrow("port");
  });
});
