import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "../connectionUrl";

describe("ZooKeeper connection URLs", () => {
  it("preserves the host:port chroot path as a ZooKeeper connect string", () => {
    expect(parseConnectionUrl("zookeeper://zk-main:2181/app").connectionString).toBe("zk-main:2181/app");
  });
});
