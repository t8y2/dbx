import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCreatePartitionedTableSql, buildTablePartitionOperationSql, getTablePartitioning } from "@/lib/backend/http";

describe("PostgreSQL table partitioning web API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the structured partitioning view from the schema endpoint", async () => {
    const payload = {
      isPartitioned: true,
      isPartition: false,
      strategy: "range",
      keyDefinition: "RANGE (sold_on)",
      keyColumns: ["sold_on"],
      partitions: [{ schema: "public", name: "sales_2024", isLeaf: true, children: [] }],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(payload),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getTablePartitioning("connection 1", "sales/db", "public", "order items")).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/schema/table-partitioning?connection_id=connection+1&database=sales%2Fdb&schema=public&table=order+items");
  });

  it("builds partition maintenance SQL through the query endpoint", async () => {
    const options = {
      databaseType: "postgres" as const,
      schema: "public",
      tableName: "sales",
      operations: [
        {
          id: "op:1",
          kind: "create" as const,
          parentSchema: "",
          parentTable: "",
          schema: "",
          name: "sales_2025",
          bound: { kind: "default" as const },
          concurrently: false,
        },
      ],
    };
    const payload = {
      statements: ['CREATE TABLE "public"."sales_2025" PARTITION OF "public"."sales" DEFAULT;'],
      warnings: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(payload),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(buildTablePartitionOperationSql(options)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/query/build-table-partition-operation-sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ options }),
    });
  });

  it("builds a partitioned CREATE TABLE through the query endpoint", async () => {
    const options = { databaseType: "postgres" as const, schema: "public", tableName: "sales", columns: [] } as never;
    const partitioning = { kind: "range" as const, columns: ["sold_on"], expression: "" };
    const payload = { statements: ['CREATE TABLE "public"."sales" (\n  "sold_on" date\n) PARTITION BY RANGE ("sold_on");'], warnings: [] };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(payload),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(buildCreatePartitionedTableSql({ options, partitioning })).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/query/build-create-partitioned-table-sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ options, partitioning }),
    });
  });
});
