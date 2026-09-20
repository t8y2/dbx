import { describe, expect, it } from "vitest";
import { driverStoreUpdateBadgeCount, showMcpUpdateBadge } from "@/lib/updates/updateBadges";

describe("component update entry badges", () => {
  it("hides separate driver and JDBC badges while their automatic updates are enabled", () => {
    expect(driverStoreUpdateBadgeCount(true, true, 3, true)).toBe(0);
  });

  it("shows badges only for categories whose automatic updates are disabled", () => {
    expect(driverStoreUpdateBadgeCount(false, true, 3, true)).toBe(3);
    expect(driverStoreUpdateBadgeCount(true, false, 3, true)).toBe(1);
    expect(driverStoreUpdateBadgeCount(false, false, 3, true)).toBe(4);
  });

  it("hides the MCP settings badge while MCP automatic updates are enabled", () => {
    expect(showMcpUpdateBadge(true, true)).toBe(false);
    expect(showMcpUpdateBadge(false, true)).toBe(true);
    expect(showMcpUpdateBadge(false, false)).toBe(false);
  });
});
