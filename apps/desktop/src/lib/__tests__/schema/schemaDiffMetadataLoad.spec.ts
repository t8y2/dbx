import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter, loadSchemaDetails, mapWithConcurrency, schemaDiffMetadataConcurrency, schemaDiffMetadataLoadPlan, shouldFetchSchemaDiffDdl, type SchemaDiffMetadataApi, type SchemaDiffMetadataProgress } from "@/lib/schema/schemaDiffMetadataLoad";
import { DEFAULT_MYSQL_OPTIONS } from "@/types/schemaDiff";
import type { TableInfo } from "@/types/database";

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("schemaDiffMetadataLoad", () => {
  it("uses adaptive metadata concurrency for MySQL-compatible databases", () => {
    expect(schemaDiffMetadataConcurrency("mysql")).toBe(2);
    expect(schemaDiffMetadataConcurrency("MariaDB")).toBe(2);
    expect(schemaDiffMetadataConcurrency("mysql", 30)).toBe(4);
    expect(schemaDiffMetadataConcurrency("mysql", 31)).toBe(2);
    expect(schemaDiffMetadataConcurrency("MariaDB", 12)).toBe(4);
    expect(schemaDiffMetadataConcurrency("postgres")).toBe(6);
    expect(schemaDiffMetadataConcurrency("postgres", 100)).toBe(6);
    expect(schemaDiffMetadataConcurrency(undefined)).toBe(6);
  });

  it("skips view DDL when views are disabled while preserving table DDL options", () => {
    expect(shouldFetchSchemaDiffDdl(true, { tables: true, views: false })).toBe(false);
    expect(shouldFetchSchemaDiffDdl(true, { tables: false, views: true })).toBe(true);
    expect(shouldFetchSchemaDiffDdl(false, { tables: false, views: true })).toBe(false);
    expect(shouldFetchSchemaDiffDdl(false, { tables: true, views: false })).toBe(true);
  });

  it("uses DDL-only metadata for views so invalid definers cannot break column discovery", () => {
    expect(
      schemaDiffMetadataLoadPlan(true, {
        tables: true,
        views: true,
        indexes: true,
        primaryKeys: true,
        uniqueKeys: true,
        foreignKeys: true,
        triggers: true,
      }),
    ).toEqual({
      columns: false,
      indexes: false,
      foreignKeys: false,
      triggers: false,
      ddl: true,
    });
  });

  it("does not load any metadata for disabled views", () => {
    expect(
      schemaDiffMetadataLoadPlan(true, {
        tables: true,
        views: false,
        indexes: true,
        primaryKeys: true,
        uniqueKeys: true,
        foreignKeys: true,
        triggers: true,
      }),
    ).toEqual({
      columns: false,
      indexes: false,
      foreignKeys: false,
      triggers: false,
      ddl: false,
    });
  });

  it("preserves enabled relational metadata for tables", () => {
    expect(
      schemaDiffMetadataLoadPlan(false, {
        tables: true,
        views: false,
        indexes: false,
        primaryKeys: true,
        uniqueKeys: false,
        foreignKeys: true,
        triggers: false,
      }),
    ).toEqual({
      columns: true,
      indexes: true,
      foreignKeys: true,
      triggers: false,
      ddl: true,
    });
  });

  it("maps items with limited concurrency and preserves output order", async () => {
    let active = 0;
    let maxActive = 0;

    const result = await mapWithConcurrency([30, 5, 10, 1], 2, async (delay, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(delay);
      active -= 1;
      return `${index}:${delay}`;
    });

    expect(result).toEqual(["0:30", "1:5", "2:10", "3:1"]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("reports each completed table while loading metadata", async () => {
    const tables = ["orders", "customers", "events"].map((name) => ({ name, table_type: "TABLE" }) as TableInfo);
    const progress: SchemaDiffMetadataProgress[] = [];
    const api: SchemaDiffMetadataApi = {
      getTableDdl: async (_connectionId, _database, _schema, table) => {
        await wait(table === "orders" ? 10 : table === "customers" ? 1 : 5);
        return `ddl:${table}`;
      },
      getColumns: async () => [],
      listIndexes: async () => [],
      listForeignKeys: async () => [],
      listTriggers: async () => [],
    };

    const details = await loadSchemaDetails(
      tables,
      {
        connectionId: "source",
        database: "db",
        schema: "public",
        dbType: "mysql",
        options: { ...DEFAULT_MYSQL_OPTIONS },
        onProgress: (value) => progress.push(value),
      },
      api,
    );

    expect(details.map((detail) => detail.name)).toEqual(["orders", "customers", "events"]);
    expect(details.map((detail) => detail.ddl)).toEqual(["ddl:orders", "ddl:customers", "ddl:events"]);
    expect(progress.map((value) => value.current)).toEqual([1, 2, 3]);
    expect(progress.map((value) => value.total)).toEqual([3, 3, 3]);
    expect(new Set(progress.map((value) => value.objectName))).toEqual(new Set(["orders", "customers", "events"]));
  });

  it("propagates the first worker error and stops scheduling new work", async () => {
    const started: number[] = [];

    await expect(
      mapWithConcurrency([1, 2, 3], 1, async (item) => {
        started.push(item);
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");

    expect(started).toEqual([1, 2]);
  });

  it("limits arbitrary async tasks", async () => {
    const runLimited = createConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    const result = await Promise.all(
      [8, 6, 4, 2].map((delay, index) =>
        runLimited(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await wait(delay);
          active -= 1;
          return index;
        }),
      ),
    );

    expect(result).toEqual([0, 1, 2, 3]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
