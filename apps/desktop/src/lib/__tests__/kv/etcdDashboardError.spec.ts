import { describe, expect, it } from "vitest";
import { classifyEtcdDashboardError, sanitizeEtcdDashboardError } from "@/lib/kv/etcdDashboardError";

describe("etcd dashboard errors", () => {
  it("recognizes legacy agents that do not implement kv_status", () => {
    expect(classifyEtcdDashboardError(new Error("Agent RPC error (-1): Unknown method: kv_status")).kind).toBe("unsupported");
    expect(classifyEtcdDashboardError("Agent RPC error (-32601): Method not found: kv_status").kind).toBe("unsupported");
    expect(classifyEtcdDashboardError("ETCD_STATUS_UNSUPPORTED: update the driver").kind).toBe("unsupported");
  });

  it("removes unrelated agent stderr from the user-facing message", () => {
    const error = "Agent RPC error (-1): connection refused. recent stderr: SLF4J(W): No SLF4J providers were found. io.netty.resolver.dns.DnsServerAddressStreamProviders warning";
    expect(sanitizeEtcdDashboardError(error)).toBe("Agent RPC error (-1): connection refused");
  });

  it("keeps ordinary request failures as request errors", () => {
    const result = classifyEtcdDashboardError(new Error("Agent RPC error (-1): etcdserver: request timed out"));
    expect(result).toEqual({
      kind: "request",
      message: "Agent RPC error (-1): etcdserver: request timed out",
    });
  });
});
