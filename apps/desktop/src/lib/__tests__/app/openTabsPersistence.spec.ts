import { describe, expect, it } from "vitest";
import { serializeOpenTabs, restoreOpenTabsPayload } from "@/lib/app/openTabsPersistence";
import type { QueryTab } from "@/types/database";

function queryTab(overrides: Partial<QueryTab>): QueryTab {
  return {
    id: "t1",
    title: "query_1",
    connectionId: "c1",
    database: "db",
    mode: "query",
    sql: "",
    isExecuting: false,
    ...overrides,
  } as QueryTab;
}

function roundTrip(tabs: QueryTab[]) {
  const saved = serializeOpenTabs(tabs);
  return restoreOpenTabsPayload({ tabs: saved, activeTabId: tabs[0]?.id ?? null }).tabs;
}

describe("openTabsPersistence originalSql round-trip", () => {
  it("restores a clean prefilled query tab as clean (sql === originalSql)", () => {
    const sql = 'SELECT * FROM "public"."users"';
    const [restored] = roundTrip([queryTab({ sql, originalSql: sql })]);
    expect(restored.sql).toBe(sql);
    expect(restored.originalSql).toBe(sql);
    expect(restored.sql === restored.originalSql).toBe(true);
  });

  it("restores a user-edited scratch query tab as dirty (originalSql stays empty)", () => {
    const [restored] = roundTrip([queryTab({ sql: "SELECT 1", originalSql: "" })]);
    expect(restored.sql).toBe("SELECT 1");
    expect(restored.originalSql).toBe("");
    expect(restored.sql === restored.originalSql).toBe(false);
  });

  it("restores an empty new query tab as clean", () => {
    const [restored] = roundTrip([queryTab({ sql: "", originalSql: "" })]);
    expect(restored.sql).toBe("");
    expect(restored.originalSql).toBe("");
  });

  it("falls back to empty originalSql for old saved state without the field (backward compat)", () => {
    const [restored] = restoreOpenTabsPayload({
      tabs: [{ id: "t1", title: "query_1", connectionId: "c1", database: "db", mode: "query", sql: "SELECT 1" }],
      activeTabId: "t1",
    }).tabs;
    expect(restored.sql).toBe("SELECT 1");
    expect(restored.originalSql).toBe("");
  });

  it("preserves an external Doris catalog across tab restore", () => {
    const [restored] = roundTrip([queryTab({ database: "dbx_catalog_completion", catalog: "dbx_mysql_catalog" })]);

    expect(restored.database).toBe("dbx_catalog_completion");
    expect(restored.catalog).toBe("dbx_mysql_catalog");
  });

  it("preserves external file versions and acknowledged state across tab restore", () => {
    const version = { sizeBytes: 9, modifiedNs: "100", contentHash: "original" };
    const ignoredVersion = { sizeBytes: 9, modifiedNs: "200", contentHash: "changed" };
    const [restored] = roundTrip([
      queryTab({
        sql: "SELECT 1",
        originalSql: "SELECT 1",
        externalSqlPath: "/tmp/query.sql",
        externalSqlFileVersion: version,
        externalSqlIgnoredFileVersion: ignoredVersion,
        externalSqlFileMissing: true,
      }),
    ]);

    expect(restored.externalSqlFileVersion).toEqual(version);
    expect(restored.externalSqlIgnoredFileVersion).toEqual(ignoredVersion);
    expect(restored.externalSqlFileMissing).toBe(true);
  });

  it("preserves the disk baseline for a dirty external file after an ignored change", () => {
    const version = { sizeBytes: 9, modifiedNs: "100", contentHash: "original" };
    const ignoredVersion = { sizeBytes: 9, modifiedNs: "200", contentHash: "changed" };
    const [restored] = roundTrip([
      queryTab({
        sql: "SELECT 2",
        originalSql: "SELECT 1",
        externalSqlPath: "/tmp/query.sql",
        externalSqlFileVersion: version,
        externalSqlIgnoredFileVersion: ignoredVersion,
      }),
    ]);

    expect(restored.sql).toBe("SELECT 2");
    expect(restored.originalSql).toBe("SELECT 1");
    expect(restored.externalSqlIgnoredFileVersion).toEqual(ignoredVersion);
  });

  it("preserves the disk baseline for a dirty external file acknowledged as missing", () => {
    const [restored] = roundTrip([
      queryTab({
        sql: "SELECT 2",
        originalSql: "SELECT 1",
        externalSqlPath: "/tmp/query.sql",
        externalSqlFileMissing: true,
      }),
    ]);

    expect(restored.sql).toBe("SELECT 2");
    expect(restored.originalSql).toBe("SELECT 1");
    expect(restored.externalSqlFileMissing).toBe(true);
  });
});
