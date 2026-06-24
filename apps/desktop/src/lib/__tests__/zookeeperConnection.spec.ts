import { describe, expect, it } from "vitest";
import { firstZooKeeperEndpoint, normalizeZooKeeperConnectString } from "../zookeeperConnection";

describe("zookeeperConnection", () => {
  it("normalizes comma, semicolon, and newline separated connect strings", () => {
    expect(normalizeZooKeeperConnectString(" zk-1:2181, zk-2:2182\nzk-3 ; ")).toBe("zk-1:2181,zk-2:2182,zk-3");
  });

  it("extracts the first host and port from a connect string", () => {
    expect(firstZooKeeperEndpoint("zk-1:2182,zk-2:2181")).toEqual({ host: "zk-1", port: 2182 });
  });

  it("strips a zookeeper URL scheme when normalizing connect strings", () => {
    expect(normalizeZooKeeperConnectString("zookeeper://zk-main:2181")).toBe("zk-main:2181");
  });

  it("uses the ZooKeeper default port when the first endpoint omits a port", () => {
    expect(firstZooKeeperEndpoint("zk-main")).toEqual({ host: "zk-main", port: 2181 });
  });

  it("parses bracketed IPv6 endpoints", () => {
    expect(firstZooKeeperEndpoint("[::1]:2281,zk-2:2181")).toEqual({ host: "::1", port: 2281 });
  });
});
