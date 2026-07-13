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
});
