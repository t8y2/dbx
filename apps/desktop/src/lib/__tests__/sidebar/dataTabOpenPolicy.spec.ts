import { describe, expect, it } from "vitest";
import { canApplyDataTabMetadata, dataTabMetadataNeedsRefresh, dataTabOpenModeFromTreeClick, findExistingDataTabCandidate } from "@/lib/sidebar/dataTabOpenPolicy";
import type { QueryTab } from "@/types/database";

function click(modifiers: Partial<Pick<MouseEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}) {
  return {
    metaKey: modifiers.metaKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
  };
}

function dataTab(id: string, title: string, schema = "public"): QueryTab {
  return {
    id,
    title,
    connectionId: "conn",
    database: "app",
    schema,
    sql: "",
    isExecuting: false,
    mode: "data",
  };
}

const usersTarget = { connectionId: "conn", database: "app", schema: "public", tableName: "users" };

describe("dataTabOpenPolicy", () => {
  it("maps the default Alt/Option modifier to explicit new-tab mode for data nodes only", () => {
    expect(dataTabOpenModeFromTreeClick("table", click({ altKey: true }), "Alt")).toBe("new-tab");
    expect(dataTabOpenModeFromTreeClick("view", click({ altKey: true }), "Alt")).toBe("new-tab");
    expect(dataTabOpenModeFromTreeClick("materialized_view", click({ altKey: true }), "Alt")).toBe("new-tab");
    expect(dataTabOpenModeFromTreeClick("database", click({ altKey: true }), "Alt")).toBe("default");
  });

  it("honors customized modifier-only shortcuts and a cleared shortcut", () => {
    expect(dataTabOpenModeFromTreeClick("table", click({ ctrlKey: true }), "Mod")).toBe("new-tab");
    expect(dataTabOpenModeFromTreeClick("table", click({ metaKey: true }), "Mod")).toBe("new-tab");
    expect(dataTabOpenModeFromTreeClick("table", click({ shiftKey: true }), "Shift")).toBe("new-tab");
    expect(dataTabOpenModeFromTreeClick("table", click({ altKey: true }), "")).toBe("default");
  });

  it("does not consume tree selection modifier combinations under the default Alt shortcut", () => {
    expect(dataTabOpenModeFromTreeClick("table", click({ metaKey: true }), "Alt")).toBe("default");
    expect(dataTabOpenModeFromTreeClick("table", click({ ctrlKey: true }), "Alt")).toBe("default");
    expect(dataTabOpenModeFromTreeClick("table", click({ shiftKey: true }), "Alt")).toBe("default");
    expect(dataTabOpenModeFromTreeClick("table", click({ altKey: true, shiftKey: true }), "Alt")).toBe("default");
  });

  it("never returns an existing tab in explicit new-tab mode", () => {
    const existing = dataTab("users", "users");
    existing.tableMeta = { schema: "public", tableName: "users", columns: [], primaryKeys: [] };

    expect(findExistingDataTabCandidate([existing], usersTarget, { openMode: "new-tab", reuseScope: "same-table" })).toBeUndefined();
    expect(findExistingDataTabCandidate([existing], usersTarget, { openMode: "new-tab", reuseScope: "none" })).toBeUndefined();
  });

  it("only reuses the same table when reuse is enabled", () => {
    const sameTable = dataTab("users", "users");
    sameTable.tableMeta = { schema: "public", tableName: "users", columns: [], primaryKeys: [] };
    const otherTable = dataTab("orders", "orders");

    expect(findExistingDataTabCandidate([sameTable], usersTarget, { openMode: "default", reuseScope: "none" })).toBeUndefined();
    expect(findExistingDataTabCandidate([sameTable], usersTarget, { openMode: "default", reuseScope: "same-table" })).toEqual({ tab: sameTable, match: "same-table" });
    expect(findExistingDataTabCandidate([otherTable], usersTarget, { openMode: "default", reuseScope: "same-table" })).toBeUndefined();
  });

  it("does not reuse a same-name table from another schema", () => {
    const archiveUsers = dataTab("archive-users", "users", "archive");
    archiveUsers.tableMeta = { schema: "archive", tableName: "users", columns: [], primaryKeys: [] };

    expect(findExistingDataTabCandidate([archiveUsers], usersTarget, { openMode: "default", reuseScope: "same-table" })).toBeUndefined();
  });

  it("allows metadata to update a tab that still points to the requested table", () => {
    const tab = dataTab("users", "users");
    tab.tableMeta = { schema: "public", tableName: "users", columns: [], primaryKeys: [] };

    expect(canApplyDataTabMetadata(tab, usersTarget, new AbortController().signal)).toBe(true);
  });

  it("uses restored table metadata as the schema identity fallback", () => {
    const tab = dataTab("users", "users");
    tab.schema = undefined;
    tab.tableMeta = { schema: "public", tableName: "users", columns: [], primaryKeys: [] };

    expect(canApplyDataTabMetadata(tab, usersTarget, new AbortController().signal)).toBe(true);
    expect(findExistingDataTabCandidate([tab], usersTarget, { openMode: "default", reuseScope: "same-table" })).toEqual({ tab, match: "same-table" });
  });

  it("ignores metadata query schemas for database-scoped tables", () => {
    const tab = dataTab("users", "users");
    tab.schema = undefined;
    tab.tableMeta = { schema: "app", tableName: "users", columns: [], primaryKeys: [] };
    const mysqlTarget = { connectionId: "conn", database: "app", tableName: "users" };

    expect(canApplyDataTabMetadata(tab, mysqlTarget, new AbortController().signal)).toBe(true);
    expect(findExistingDataTabCandidate([tab], mysqlTarget, { openMode: "default", reuseScope: "same-table" })).toEqual({ tab, match: "same-table" });
  });

  it("rejects metadata after its request is cancelled", () => {
    const tab = dataTab("users", "users");
    tab.tableMeta = { schema: "public", tableName: "users", columns: [], primaryKeys: [] };
    const controller = new AbortController();
    controller.abort();

    expect(canApplyDataTabMetadata(tab, usersTarget, controller.signal)).toBe(false);
  });

  it("rejects stale metadata after a reusable tab switches to another table", () => {
    const tab = dataTab("reused", "orders");
    tab.tableMeta = { schema: "public", tableName: "orders", columns: [], primaryKeys: [] };

    expect(canApplyDataTabMetadata(tab, usersTarget, new AbortController().signal)).toBe(false);
  });

  it("refreshes missing, restored, and expired table metadata", () => {
    const now = 100_000;
    const ttl = 30_000;
    const tab = dataTab("users", "users");

    expect(dataTabMetadataNeedsRefresh(tab, ttl, now)).toBe(true);

    tab.tableMeta = {
      schema: "public",
      tableName: "users",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    };
    expect(dataTabMetadataNeedsRefresh(tab, ttl, now)).toBe(true);

    tab.tableMetaUpdatedAt = now - ttl + 1;
    expect(dataTabMetadataNeedsRefresh(tab, ttl, now)).toBe(false);

    tab.tableMetaUpdatedAt = now - ttl;
    expect(dataTabMetadataNeedsRefresh(tab, ttl, now)).toBe(true);
  });
});
