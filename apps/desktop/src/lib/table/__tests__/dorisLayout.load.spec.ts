import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/api", () => ({ listDorisPartitions: vi.fn() }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ loadObjectDdl: vi.fn() }));

import * as api from "@/lib/backend/api";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { loadDorisTableLayout } from "../dorisLayout";

const DDL = `CREATE TABLE \`demo\`.\`orders\` (
  \`id\` BIGINT NOT NULL,
  \`dt\` DATE NOT NULL
) ENGINE=OLAP
DUPLICATE KEY(\`id\`)
PARTITION BY RANGE(\`dt\`)
(PARTITION p1 VALUES [('2024-01-01'), ('2024-02-01')))
DISTRIBUTED BY HASH(\`id\`) BUCKETS 4;`;

describe("loadDorisTableLayout", () => {
  beforeEach(() => {
    vi.mocked(loadObjectDdl).mockReset();
    vi.mocked(api.listDorisPartitions).mockReset();
  });

  it("combines cached DDL with SHOW PARTITIONS rows", async () => {
    vi.mocked(loadObjectDdl).mockResolvedValue({ ddl: DDL, cacheStatus: "memory" });
    vi.mocked(api.listDorisPartitions).mockResolvedValue({ supported: true, partitions: [{ name: "p1", buckets: 4 }] });
    const layout = await loadDorisTableLayout({ connectionId: "c", database: "demo", tableName: "orders" });
    expect(loadObjectDdl).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "c", database: "demo", schema: "demo", tableName: "orders" }), { force: undefined });
    expect(api.listDorisPartitions).toHaveBeenCalledWith("c", "demo", "demo", "orders", undefined);
    expect(layout.partitions).toHaveLength(1);
    expect(layout.distribution.buckets).toBe(4);
  });

  it("keeps the table summary and maps a permission error when SHOW PARTITIONS fails", async () => {
    vi.mocked(loadObjectDdl).mockResolvedValue({ ddl: DDL, cacheStatus: "memory" });
    vi.mocked(api.listDorisPartitions).mockRejectedValue(new Error("Access denied; you need SHOW privilege"));
    const layout = await loadDorisTableLayout({ connectionId: "c", database: "demo", tableName: "orders" });
    expect(layout.model).toBe("duplicate");
    expect(layout.partitions).toEqual([]);
    expect(layout.unavailableReason).toBe("permissionDenied");
  });

  it("propagates a DDL failure because there is nothing to show", async () => {
    vi.mocked(loadObjectDdl).mockRejectedValue(new Error("DDL unavailable"));
    await expect(loadDorisTableLayout({ connectionId: "c", database: "demo", tableName: "orders" })).rejects.toThrow("DDL unavailable");
  });
});
