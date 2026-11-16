import { describe, expect, it } from "vitest";
import { parseRedisDesktopManagerImport } from "@/lib/imports/redisDesktopManagerImport";

const parse = (value: unknown) => parseRedisDesktopManagerImport(JSON.stringify(value));

describe("RedisDesktopManager connection import", () => {
  it("imports plain connections with fresh identities and preserves credentials verbatim", () => {
    const data = [{ id: "rdm-id", host: " localhost ", name: "Development", username: " acl-user ", auth: " secret ", port: "6380" }];
    const first = parse(data).connections[0]!;
    expect(first).toMatchObject({ db_type: "redis", driver_profile: "redis", host: "localhost", name: "Development", port: 6380, username: " acl-user ", password: " secret ", ssl: false });
    expect(first.id).not.toBe("rdm-id");
    expect(parse(data).connections[0]!.id).not.toBe(first.id);
    expect(data[0]!.id).toBe("rdm-id");
  });

  it("preserves nested and same-named groups, literal slashes and root ordering", () => {
    const result = parse([{ host: "root" }, { type: "group", name: "Prod/EU", connections: [{ type: "group", name: "Cache", connections: [{ host: "first" }] }] }, { type: "group", name: "Prod/EU", connections: [{ host: "second" }] }]);
    expect(result.layout!.groups.map((group) => group.name)).toEqual(["Prod/EU", "Cache", "Prod/EU"]);
    expect(result.layout!.order[0]).toEqual({ type: "connection", id: result.connections[0]!.id });
    expect(result.layout!.order[1]).toMatchObject({ type: "group", children: [{ type: "group", children: [{ type: "connection", id: result.connections[1]!.id }] }] });
    expect(result.layout!.order[2]).toMatchObject({ type: "group", children: [{ type: "connection", id: result.connections[2]!.id }] });
  });

  it("maps TLS certificates, timeout units, key filters and SSH key/password authentication", () => {
    const {
      connections: [config],
    } = parse([
      {
        host: "cache",
        ssl: true,
        ssl_ca_cert_path: "/ca.pem",
        ssl_local_cert_path: "/client.pem",
        ssl_private_key_path: "/client.key",
        ssl_ignore_all_errors: true,
        timeout_connect: 1500,
        timeout_execute: 5000,
        keys_pattern: "app:*",
        namespace_separator: "::",
        ssh_host: "bastion",
        ssh_port: 2222,
        ssh_user: "operator",
        ssh_password: " ssh-secret ",
        ssh_private_key_path: "/id_ed25519",
      },
    ]);
    expect(config).toMatchObject({
      ssl: true,
      ca_cert_path: "/ca.pem",
      client_cert_path: "/client.pem",
      client_key_path: "/client.key",
      connect_timeout_secs: 2,
      connect_timeout_inherit: false,
      query_timeout_secs: 5,
      query_timeout_inherit: false,
      redis_key_filter: "app:*",
      redis_key_separator: "::",
      transport_layers: [{ type: "ssh", enabled: true, host: "bastion", port: 2222, user: "operator", password: " ssh-secret ", key_path: "/id_ed25519", auth_method: "key+password" }],
    });
    expect(config).not.toHaveProperty("ssl_ignore_all_errors");
  });

  it("maps SSH agents and does not treat the string false as enabling TLS", () => {
    const config = parse([{ host: "cache", ssl: "false", ssh_host: "jump", ssh_user: "user", ssh_agent: true, ssh_agent_path: "/agent.sock" }]).connections[0]!;
    expect(config.ssl).toBe(false);
    expect(config.transport_layers![0]).toMatchObject({ type: "ssh", port: 22, auth_method: "agent", use_ssh_agent: true, ssh_agent_sock_path: "/agent.sock" });
  });

  it.each([0, -1, 65536, 1.5, "invalid", true])("rejects invalid port %s before saving any connection", (value) => {
    expect(() => parse([{ host: "valid" }, { host: "invalid", port: value, auth: "do-not-disclose" }])).toThrow("invalid port");
    try {
      parse([{ host: "invalid", port: value, auth: "do-not-disclose" }]);
    } catch (error) {
      expect(String(error)).not.toContain("do-not-disclose");
    }
  });

  it.each([
    null,
    {},
    [],
    [null],
    [{ name: "missing host" }],
    [{ host: "cache", db_type: "redis" }],
    [{ type: "group", name: "bad" }],
    [{ host: "cache", ssl: "yes" }],
    [{ host: "cache", ssl: true, ssl_local_cert_path: "/client.pem" }],
    [{ host: "cache", ssh_host: "jump" }],
    [{ host: "cache", timeout_connect: -1 }],
  ])("rejects malformed or unsupported exports %#", (value) => {
    expect(() => parse(value)).toThrow(/RedisDesktopManager/);
  });

  it("rejects invalid JSON and excessive nesting", () => {
    expect(() => parseRedisDesktopManagerImport("not-json")).toThrow("invalid JSON");
    let items: unknown[] = [{ host: "cache" }];
    for (let index = 0; index < 34; index++) items = [{ type: "group", name: "nested", connections: items }];
    expect(() => parse(items)).toThrow("nested groups");
  });
});
