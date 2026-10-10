import { describe, expect, it } from "vitest";
import { oceanbaseSpaceRows } from "@/lib/table/oceanbaseSpaceStatistics";
import type { ObjectSpaceStatistics } from "@/types/database";

describe("OceanBase space presentation", () => {
  const t = (key: string) => key;
  const base: ObjectSpaceStatistics = {
    status: "available",
    source: "SYS.DBA_OB_TABLE_SPACE_USAGE",
    replica_scope: "leader",
    data_bytes: 0,
    allocated_bytes: 8192,
    components_status: "available",
    components: [{ kind: "INDEX", data_bytes: 20, allocated_bytes: 4096 }],
  };
  it("keeps real zero, missing LOB, Leader scope and independent index sizes visible", () => {
    const rows = oceanbaseSpaceRows(base, t);
    expect(rows.find((row) => row.label === "objects.spaceData")?.value).toBe("0 B");
    expect(rows.find((row) => row.label === "objects.spaceAllocated")?.value).toBe("8.00 KB");
    expect(rows.find((row) => row.label === "objects.spaceLob · objects.spaceData")?.value).toBe("objects.spaceStatus.unknown");
    expect(rows.find((row) => row.label === "objects.spaceIndexes · objects.spaceAllocated")?.value).toBe("4.00 KB");
    expect(rows.find((row) => row.label === "objects.spaceScope")?.value).toBe("objects.spaceLeader");
  });
  it("explains permission failure without showing zero", () => {
    const rows = oceanbaseSpaceRows({ ...base, status: "permission_denied", data_bytes: null, allocated_bytes: null }, t);
    expect(rows.find((row) => row.label === "objects.spaceState")?.value).toBe("objects.spaceStatus.permission_denied");
    expect(rows.find((row) => row.label === "objects.spaceData")?.value).toBe("objects.spaceStatus.unknown");
  });
  it("does not add OceanBase details for other drivers", () => {
    expect(oceanbaseSpaceRows(null, t)).toEqual([]);
  });
});
