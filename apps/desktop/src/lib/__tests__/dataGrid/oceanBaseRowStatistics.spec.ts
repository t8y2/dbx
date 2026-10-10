import { describe, expect, it, vi } from "vitest";
import { estimatedRowsDetails, estimatedRowsText, loadOceanBaseRowStatistics, oceanBaseTableStatistics } from "@/lib/dataGrid/oceanBaseRowStatistics";
import type { ObjectStatistics } from "@/types/database";

const mocks = vi.hoisted(() => ({ listObjectStatistics: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ listObjectStatistics: mocks.listObjectStatistics }));
const t = (key: string) => key;

describe("OceanBase optimizer row statistics", () => {
  it.each([
    ["ORA-01031: insufficient privileges", "permission_denied"],
    ["ORA-00904 invalid identifier", "unsupported"],
    ["ORA-00942 table or view does not exist", "unknown"],
    ["network timeout", "error"],
  ])("keeps %s distinct from missing statistics and zero", async (error, status) => {
    mocks.listObjectStatistics.mockRejectedValueOnce(error);
    const snapshot = await loadOceanBaseRowStatistics(error, "DB", "APP", true);
    const stat = oceanBaseTableStatistics(snapshot, "T", "APP");
    expect(stat.estimated_rows).toBeNull();
    expect(estimatedRowsText(stat, t)).toBe(`objects.rowsStatus_${status}`);
  });

  it("matches exact quoted identifiers and never borrows another schema's estimate", () => {
    const snapshot = {
      statistics: [
        { name: "Table", schema: "APP", estimated_rows: 0, rows_status: "available" as const },
        { name: "TABLE", schema: "APP", estimated_rows: 9, rows_status: "available" as const },
        { name: "Table", schema: "OTHER", estimated_rows: 7, rows_status: "available" as const },
      ],
    };
    expect(estimatedRowsText(oceanBaseTableStatistics(snapshot, "Table", "APP"), t)).toBe("0");
    expect(oceanBaseTableStatistics(snapshot, "TABLE", "APP").estimated_rows).toBe(9);
    expect(oceanBaseTableStatistics(snapshot, "Table", "OTHER").estimated_rows).toBe(7);
    expect(oceanBaseTableStatistics(snapshot, "table", "APP").rows_status).toBe("unknown");
  });

  it("shows only genuine collection time and keeps stale estimates visible", () => {
    const stats: ObjectStatistics = { name: "T", estimated_rows: 42, rows_status: "available", rows_stale: true, rows_last_analyzed: "2026-01-01 01:02:03" };
    expect(estimatedRowsText(stats, t)).toBe("42");
    expect(estimatedRowsDetails(stats, t)).toContainEqual({ label: "objects.rowsLastAnalyzed", value: "2026-01-01 01:02:03" });
    expect(estimatedRowsDetails({ ...stats, rows_last_analyzed: null }, t)).toContainEqual({ label: "objects.rowsLastAnalyzed", value: "" });
    expect(estimatedRowsDetails(stats, t)).toContainEqual({ label: "objects.rowsFreshness", value: "objects.rowsStale" });
  });

  it("shares a schema batch, refreshes explicitly and ignores an old response in the cache", async () => {
    let resolveOld!: (stats: ObjectStatistics[]) => void;
    mocks.listObjectStatistics.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    const old = loadOceanBaseRowStatistics("cache-race", "DB", "APP", true);
    expect(loadOceanBaseRowStatistics("cache-race", "DB", "APP")).toBe(old);
    mocks.listObjectStatistics.mockResolvedValueOnce([{ name: "T", schema: "APP", estimated_rows: 99 }]);
    const fresh = await loadOceanBaseRowStatistics("cache-race", "DB", "APP", true);
    resolveOld([{ name: "T", schema: "APP", estimated_rows: 1 }]);
    await old;
    expect(await loadOceanBaseRowStatistics("cache-race", "DB", "APP")).toBe(fresh);
    mocks.listObjectStatistics.mockResolvedValueOnce([]);
    const other = await loadOceanBaseRowStatistics("cache-race", "DB", "OTHER");
    expect(other.statistics).toEqual([]);
  });

  it("keeps space and row fields in one snapshot and clears removed table values on refresh", async () => {
    const space = { status: "available", source: "SYS.DBA_OB_TABLE_SPACE_USAGE", replica_scope: "leader", data_bytes: 0, allocated_bytes: 0, components_status: "available", components: [] };
    mocks.listObjectStatistics.mockResolvedValueOnce([{ name: "T", schema: "APP", estimated_rows: 7, space }]);
    const first = await loadOceanBaseRowStatistics("space-refresh", "DB", "APP", true);
    expect(oceanBaseTableStatistics(first, "T", "APP")).toMatchObject({ estimated_rows: 7, space });
    expect(await loadOceanBaseRowStatistics("space-refresh", "DB", "APP")).toBe(first);
    mocks.listObjectStatistics.mockResolvedValueOnce([]);
    const refreshed = await loadOceanBaseRowStatistics("space-refresh", "DB", "APP", true);
    const removed = oceanBaseTableStatistics(refreshed, "T", "APP");
    expect(removed.estimated_rows).toBeNull();
    expect(removed.space?.allocated_bytes).toBeNull();
    expect(removed.space?.status).toBe("unknown");
  });
});
