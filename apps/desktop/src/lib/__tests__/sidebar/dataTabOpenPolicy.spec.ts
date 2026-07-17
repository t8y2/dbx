import { describe, expect, it } from "vitest";
import { canApplyDataTabMetadata, dataTabOpenModeFromTreeClick, findExistingDataTabCandidate } from "@/lib/sidebar/dataTabOpenPolicy";
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

    expect(findExistingDataTabCandidate([existing], usersTarget, { openMode: "new-tab", reuseDataTab: true })).toBeUndefined();
    expect(findExistingDataTabCandidate([existing], usersTarget, { openMode: "new-tab", reuseDataTab: false })).toBeUndefined();
  });

  it("preserves same-table activation and configured database-tab reuse for ordinary opens", () => {
    const sameTable = dataTab("users", "users");
    sameTable.tableMeta = { schema: "public", tableName: "users", columns: [], primaryKeys: [] };
    const otherTable = dataTab("orders", "orders");

    expect(findExistingDataTabCandidate([sameTable], usersTarget, { openMode: "default", reuseDataTab: false })).toEqual({ tab: sameTable, match: "same-table" });
    expect(findExistingDataTabCandidate([otherTable], usersTarget, { openMode: "default", reuseDataTab: true })).toEqual({ tab: otherTable, match: "database" });
    expect(findExistingDataTabCandidate([otherTable], usersTarget, { openMode: "default", reuseDataTab: false })).toBeUndefined();
  });

  it("allows metadata to update a tab that still points to the requested table", () => {
    const tab = dataTab("users", "users");
    tab.tableMeta = { schema: "public", tableName: "users", columns: [], primaryKeys: [] };

    expect(canApplyDataTabMetadata(tab, usersTarget, new AbortController().signal)).toBe(true);
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
});
