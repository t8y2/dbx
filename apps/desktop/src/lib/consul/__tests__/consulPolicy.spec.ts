import { describe, expect, it } from "vitest";
import { capabilityVisible, capabilityWritable, requireConfirmation, scopeHasWildcard } from "@/lib/consul/consulPolicy";
import { nextWatchIndex } from "@/lib/consul/watchState";

describe("Consul domain policies", () => {
  it("keeps forbidden separate from unsupported", () => {
    expect(capabilityVisible("forbidden")).toBe(true);
    expect(capabilityVisible("unsupported")).toBe(false);
    expect(capabilityWritable("supported", false)).toBe(true);
    expect(capabilityWritable("supported", true)).toBe(false);
  });

  it("requires explicit wildcard scope and exact confirmations", () => {
    expect(scopeHasWildcard({ datacenter: "dc1", namespace: "*", partition: "default" })).toBe(true);
    expect(scopeHasWildcard({ datacenter: "dc1", namespace: "team", partition: "default" })).toBe(false);
    expect(requireConfirmation("DELETE team", "DELETE team")).toBe(true);
    expect(requireConfirmation("DELETE team", "delete team")).toBe(false);
  });

  it("resets blocking indexes after zero or rollback", () => {
    expect(nextWatchIndex("50", "0")).toEqual({ index: "1", reset: true });
    expect(nextWatchIndex("50", "49")).toEqual({ index: "1", reset: true });
    expect(nextWatchIndex("50", "51")).toEqual({ index: "51", reset: false });
  });
});
