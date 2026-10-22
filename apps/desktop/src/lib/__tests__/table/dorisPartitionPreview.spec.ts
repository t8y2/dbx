import { beforeEach, describe, expect, it, vi } from "vitest";

// Fresh mocks per test: mutating a shared mock that later rejects (via
// mockReset/mockClear in beforeEach) trips unhandled-rejection detection in
// vitest, so each test gets a newly created vi.fn through the indirection.
const mocks = vi.hoisted(() => ({ executeQuery: vi.fn(), buildTableSelectSql: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: (...args: unknown[]) => mocks.executeQuery(...args),
  buildTableSelectSql: (options: unknown) => mocks.buildTableSelectSql(options),
}));

import { latestDorisPreviewPartition } from "@/lib/table/dorisPartitionPreview";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql";

const partitionsResult = {
  columns: ["PartitionId", "PartitionName", "State"],
  rows: [
    [101, "p20251017", "NORMAL"],
    [103, "p20251019", "NORMAL"],
    [102, "p20251018", "NORMAL"],
  ],
};

beforeEach(() => {
  mocks.executeQuery = vi.fn();
  mocks.buildTableSelectSql = vi.fn().mockResolvedValue("SELECT 1");
});

describe("latestDorisPreviewPartition", () => {
  it("picks the partition with the greatest partition id", async () => {
    mocks.executeQuery.mockResolvedValue(partitionsResult);
    await expect(latestDorisPreviewPartition({ connectionId: "conn-latest", databaseType: "doris", database: "dw", tableName: "t" })).resolves.toBe("p20251019");
    expect(mocks.executeQuery).toHaveBeenCalledWith("conn-latest", "dw", "SHOW PARTITIONS FROM `dw`.`t`", undefined, undefined, expect.objectContaining({ maxRows: 10000 }));
  });

  it("qualifies external catalogs with the three-part form", async () => {
    mocks.executeQuery.mockResolvedValue(partitionsResult);
    await latestDorisPreviewPartition({ connectionId: "conn-catalog", databaseType: "starrocks", catalog: "hive_catalog", database: "dw", tableName: "t" });
    expect(mocks.executeQuery.mock.calls[0]?.[2]).toBe("SHOW PARTITIONS FROM `hive_catalog`.`dw`.`t`");
  });

  it("skips non-Doris engines without querying", async () => {
    await expect(latestDorisPreviewPartition({ connectionId: "conn-mysql", databaseType: "mysql", database: "dw", tableName: "t" })).resolves.toBeUndefined();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it("returns undefined when SHOW PARTITIONS fails (non-partitioned table)", async () => {
    mocks.executeQuery.mockRejectedValue(new Error("errCode = 2, detailMessage = Table[t] is not partitioned"));
    await expect(latestDorisPreviewPartition({ connectionId: "conn-unpartitioned", databaseType: "doris", database: "dw", tableName: "t" })).resolves.toBeUndefined();
  });
});

describe("buildTableSelectSql — Doris preview partition hint", () => {
  it("forwards the newest partition as defaultPartition when no WHERE is supplied", async () => {
    mocks.executeQuery.mockResolvedValue(partitionsResult);
    await buildTableSelectSql({ databaseType: "doris", connectionId: "conn-hint", database: "dw", tableName: "t" });
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ defaultPartition: "p20251019" }));
  });

  it("keeps the user's WHERE untouched and skips the partition lookup", async () => {
    await buildTableSelectSql({ databaseType: "doris", connectionId: "conn-where", database: "dw", tableName: "t", whereInput: "dt >= '2026-10-13'" });
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.not.objectContaining({ defaultPartition: expect.anything() }));
  });

  it("does not look up partitions without a connection id", async () => {
    await buildTableSelectSql({ databaseType: "doris", database: "dw", tableName: "t" });
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });
});
