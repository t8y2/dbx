import { describe, expect, it } from "vitest";
import { kvRootNodeLabel } from "@/lib/kvRootPresentation";

describe("kv root presentation", () => {
  it("keeps etcd under Keys but shows ZooKeeper as root path", () => {
    expect(kvRootNodeLabel("etcd")).toBe("Keys");
    expect(kvRootNodeLabel("zookeeper")).toBe("/");
  });
});
