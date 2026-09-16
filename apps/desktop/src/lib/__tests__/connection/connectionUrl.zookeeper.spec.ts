import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("ZooKeeper connection URLs", () => {
  it("parses a two-node ensemble and uses the first endpoint for host and port", () => {
    const parsed = parseConnectionUrl("zookeeper://zk-1:2181,zk-2:2182");

    expect(parsed.host).toBe("zk-1");
    expect(parsed.port).toBe(2181);
    expect(parsed.connectionString).toBe("zk-1:2181,zk-2:2182");
  });

  it("parses three nodes and preserves query parameters except name", () => {
    const parsed = parseConnectionUrl("zookeeper://zk-1:2181,zk-2:2182,zk-3:2183?session_timeout=30000&name=Production");

    expect(parsed.name).toBe("Production");
    expect(parsed.urlParams).toBe("session_timeout=30000");
    expect(parsed.connectionString).toBe("zk-1:2181,zk-2:2182,zk-3:2183");
  });

  it("preserves a shared chroot separately from query parameters", () => {
    const parsed = parseConnectionUrl("zookeeper://zk-1:2181,zk-2:2181/services/app?connect_timeout=5000");

    expect(parsed.connectionString).toBe("zk-1:2181,zk-2:2181/services/app");
    expect(parsed.urlParams).toBe("connect_timeout=5000");
  });

  it("decodes credentials that apply to the ensemble", () => {
    const parsed = parseConnectionUrl("zookeeper://dbx%40ops:p%40ss@zk-1:2181,zk-2:2181/app");

    expect(parsed.username).toBe("dbx@ops");
    expect(parsed.password).toBe("p@ss");
    expect(parsed.connectionString).toBe("zk-1:2181,zk-2:2181/app");
  });

  it("supports bracketed IPv6 endpoints without confusing address colons with separators", () => {
    const parsed = parseConnectionUrl("zookeeper://[2001:db8::1]:2181,[2001:db8::2]:2281/app");

    expect(parsed.host).toBe("2001:db8::1");
    expect(parsed.port).toBe(2181);
    expect(parsed.connectionString).toBe("[2001:db8::1]:2181,[2001:db8::2]:2281/app");
  });

  it("rejects malformed or empty ensemble endpoints", () => {
    expect(() => parseConnectionUrl("zookeeper://zk-1:2181,,zk-2:2181")).toThrow("Invalid connection URL");
    expect(() => parseConnectionUrl("zookeeper://zk-1:not-a-port,zk-2:2181")).toThrow("Invalid connection URL");
    expect(() => parseConnectionUrl("zookeeper://2001:db8::1:2181,zk-2:2181")).toThrow("Invalid connection URL");
  });

  it("preserves the host:port chroot path as a ZooKeeper connect string", () => {
    const parsed = parseConnectionUrl("zookeeper://zk-main:2181/app");

    expect(parsed.host).toBe("zk-main");
    expect(parsed.port).toBe(2181);
    expect(parsed.connectionString).toBe("zk-main:2181/app");
  });
});
