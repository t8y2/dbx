import { describe, expect, it } from "vitest";
import { etcdDelete, etcdGet, etcdListPrefix, etcdPut, etcdSupportsTtl, type KvPutOptions } from "@/lib/backend/api";

describe("etcd frontend API contract", () => {
  it("exposes TTL capability detection and TTL-aware put options", () => {
    const expiring: KvPutOptions = { ttl: 30 };
    const preserving: KvPutOptions = { preserveLease: true };

    expect(expiring.ttl).toBe(30);
    expect(preserving.preserveLease).toBe(true);
    expect(typeof etcdSupportsTtl).toBe("function");
    expect(typeof etcdListPrefix).toBe("function");
    expect(typeof etcdGet).toBe("function");
    expect(typeof etcdPut).toBe("function");
    expect(typeof etcdDelete).toBe("function");
  });
});
