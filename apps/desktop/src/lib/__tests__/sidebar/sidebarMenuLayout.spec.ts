import { describe, expect, it, vi } from "vitest";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import { buildSidebarMenuLayout, normalizeSidebarMenuPinnedActions, reorderSidebarMenuEntries, sidebarMenuActions } from "@/lib/sidebar/sidebarMenuLayout";

const t = (key: string) => key;
const item = (id: string, extras: Partial<ContextMenuItem> = {}): ContextMenuItem => ({ sidebarActionId: id, label: id, action: vi.fn(), ...extras });
const leaves = (items: readonly ContextMenuItem[]): ContextMenuItem[] => items.flatMap((entry) => (entry.children?.length ? leaves(entry.children) : entry.separator ? [] : [entry]));

describe("sidebar menu layout", () => {
  it.each([
    ["connection", "connectionSettings"],
    ["database", "databaseSettings"],
    ["schema", "schemaSettings"],
    ["table", "tableSettings"],
    ["view", "viewSettings"],
  ] as const)("names settings for the current %s scope", (scope, key) => {
    const menu = buildSidebarMenuLayout([item("contextMenu.configureVisibleObjects")], scope, "grouped", [], t, { hiddenPrimaryIds: ["contextMenu.configureVisibleObjects"] });
    expect(menu[0].label).toBe(`sidebarMenu.groups.${key}`);
    expect(menu[0].sidebarActionId).toBe("group.organize");
  });
  it.each(["database", "schema", "table", "view"] as const)("shows pinning by default in %s menus and allows hiding and ordering it", (scope) => {
    const pin = item("sidebar.togglePinnedObject");
    const query = item("contextMenu.newQuery");
    const raw = [query, pin];
    expect(buildSidebarMenuLayout(raw, scope, "grouped", [], t, { order: [pin.sidebarActionId!, query.sidebarActionId!] }).filter((entry) => !entry.separator)).toEqual([pin, query]);
    const hidden = buildSidebarMenuLayout(raw, scope, "grouped", [], t, { hiddenPrimaryIds: [pin.sidebarActionId!] });
    expect(hidden).not.toContain(pin);
    expect(hidden.find((entry) => entry.sidebarActionId === "group.organize")?.children).toContainEqual(pin);
    expect(buildSidebarMenuLayout(raw, scope, "full", [], t, { hiddenPrimaryIds: [pin.sidebarActionId!] })).toEqual(raw);
  });

  it("uses the same optional placement and ordering for visible-object and schema filters", () => {
    const filters = [item("contextMenu.configureVisibleObjects"), item("visibleSchemas.title")];
    const defaults = buildSidebarMenuLayout(filters, "connection", "grouped", [], t, { order: ["visibleSchemas.title", "contextMenu.configureVisibleObjects"] });
    expect(defaults).toEqual([filters[1], filters[0]]);
    const hidden = buildSidebarMenuLayout(filters, "connection", "grouped", [], t, { hiddenPrimaryIds: filters.map((entry) => entry.sidebarActionId!) });
    expect(hidden[0].sidebarActionId).toBe("group.organize");
    expect(hidden[0].children).toEqual(filters);
  });

  it("groups database-wide search with data tools without an extra management submenu", () => {
    const search = item("databaseSearch.open");
    const menu = buildSidebarMenuLayout([search, item("contextMenu.exportDatabase")], "database", "grouped", [], t);
    expect(menu.map((entry) => entry.sidebarActionId)).toEqual(["group.data"]);
    expect(menu[0].children).toContainEqual(search);
  });
  it("shows database-specific management actions directly by default and allows opting out", () => {
    const dashboard = item("contextMenu.serverDashboard");
    const processes = item("contextMenu.processList");
    const trace = item("contextMenu.sqlServerTrace");
    const input = [dashboard, processes, trace, item("contextMenu.newQuery")];
    const defaults = buildSidebarMenuLayout(input, "connection", "grouped", [], t);
    for (const action of [dashboard, processes, trace]) expect(defaults).toContain(action);
    const customized = buildSidebarMenuLayout(input, "connection", "grouped", [], t, { hiddenPrimaryIds: ["contextMenu.serverDashboard", "contextMenu.sqlServerTrace"] });
    expect(customized).not.toContain(dashboard);
    expect(customized).not.toContain(trace);
    expect(customized).toContain(processes);
    expect(customized.find((entry) => entry.sidebarActionId === "group.manage")?.children).toEqual(expect.arrayContaining([dashboard, trace]));
    expect(leaves(customized)).toHaveLength(input.length);
    expect(buildSidebarMenuLayout(input, "connection", "full", [], t, { hiddenPrimaryIds: [dashboard.sidebarActionId!], order: [processes.sidebarActionId!] })).toEqual(input);
  });

  it("sorts primary actions and groups independently while leaving dangerous actions last", () => {
    const input = [item("contextMenu.refreshChildren"), item("contextMenu.viewData"), item("contextMenu.copyName"), item("contextMenu.importData"), item("contextMenu.viewDdl"), item("contextMenu.dropTable", { variant: "destructive" })];
    const grouped = buildSidebarMenuLayout(input, "table", "grouped", [], t, { order: ["group.danger", "group.data", "group.copy", "contextMenu.refreshChildren", "contextMenu.viewData", "group.structure"] });
    expect(grouped.filter((entry) => !entry.separator).map((entry) => entry.sidebarActionId)).toEqual(["contextMenu.refreshChildren", "contextMenu.viewData", "group.data", "group.copy", "group.structure", "group.danger"]);
    expect(leaves(grouped).map((entry) => entry.action)).toEqual(expect.arrayContaining(input.map((entry) => entry.action)));
  });

  it("keeps the connection lifecycle entry in its saved position when its status changes", () => {
    for (const id of ["contextMenu.openConnection", "connection.cancelConnecting", "contextMenu.disconnectConnection"]) {
      const input = [item("contextMenu.newQuery"), item(id), item("contextMenu.refreshChildren")];
      const menu = buildSidebarMenuLayout(input, "connection", "grouped", [], t, { order: ["contextMenu.refreshChildren", "action.connectionState", "contextMenu.newQuery"] });
      expect(menu.filter((entry) => !entry.separator).map((entry) => entry.sidebarActionId)).toEqual(["contextMenu.refreshChildren", id, "contextMenu.newQuery"]);
    }
  });

  it("retains temporarily unavailable preferences while moving visible entries", () => {
    expect(reorderSidebarMenuEntries(["a", "temporarily.unavailable", "b", "group.copy"], ["a", "b", "c"], 2, 0)).toEqual(["c", "temporarily.unavailable", "a", "group.copy", "b"]);
    expect(reorderSidebarMenuEntries(["a"], ["a"], 0, -1)).toEqual(["a"]);
  });
  it("places structure and copy groups before data tools regardless of source order", () => {
    const input = [item("contextMenu.importData"), item("contextMenu.copyName"), item("contextMenu.viewDdl")];
    const grouped = buildSidebarMenuLayout(input, "table", "grouped", [], t);
    expect(grouped.map((entry) => entry.label)).toEqual(["sidebarMenu.groups.structure", "sidebarMenu.groups.copy", "sidebarMenu.groups.data"]);
    expect(buildSidebarMenuLayout(input, "table", "full", [], t)).toEqual(input);
  });
  it("retains every action callback and guard in grouped and full menus", () => {
    const input = [
      item("contextMenu.viewData"),
      item("contextMenu.exportData", {
        children: [
          { label: "CSV", action: vi.fn() },
          { label: "JSON", action: vi.fn() },
        ],
      }),
      item("common.more", { variant: "destructive", children: [item("contextMenu.vacuumTable", { variant: "destructive" }), item("contextMenu.dropTable", { variant: "destructive" })] }),
      item("contextMenu.refreshChildren", { shortcut: "F5" }),
    ];
    expect(buildSidebarMenuLayout(input, "table", "full", [], t)).toEqual(input);
    const grouped = buildSidebarMenuLayout(input, "table", "grouped", [], t);
    expect(leaves(grouped).map((entry) => entry.action)).toEqual(expect.arrayContaining(leaves(input).map((entry) => entry.action)));
    expect(leaves(grouped)).toHaveLength(leaves(input).length);
    expect(grouped.find((entry) => entry.label === "sidebarMenu.groups.structure")?.children?.[0].sidebarActionId).toBe("contextMenu.vacuumTable");
    expect(grouped.find((entry) => entry.label === "sidebarMenu.groups.danger")?.children?.[0].sidebarActionId).toBe("contextMenu.dropTable");
    expect(grouped.find((entry) => entry.sidebarActionId === "contextMenu.refreshChildren")?.shortcut).toBe("F5");
  });

  it("promotes an entire export submenu by its stable ID without duplication or a third level", () => {
    const exportItem = item("contextMenu.exportData", { label: "导出数据（3 张表）", children: [{ label: "CSV", action: vi.fn() }] });
    const input = [exportItem, item("contextMenu.viewData")];
    const grouped = buildSidebarMenuLayout(input, "table", "grouped", ["contextMenu.exportData"], t);
    expect(grouped[0].sidebarActionId).toBe("contextMenu.viewData");
    expect(grouped[1]).toBe(exportItem);
    expect(leaves(grouped)).toHaveLength(2);
    expect(buildSidebarMenuLayout([{ ...exportItem, label: "Export" }], "table", "grouped", ["contextMenu.exportData"], t)[0].sidebarActionId).toBe("contextMenu.exportData");
  });

  it("flattens grouped export choices but retains disabled parents and invisible children", () => {
    let disabled = true;
    const exportItem = item("contextMenu.exportData", {
      label: "Export",
      disabled: () => disabled,
      children: [
        { label: "CSV", action: vi.fn() },
        { label: "Secret", visible: false, action: vi.fn() },
      ],
    });
    const grouped = buildSidebarMenuLayout([exportItem], "table", "grouped", [], t);
    const child = grouped[0].children![0];
    expect(child.label).toBe("Export · CSV");
    expect(grouped[0].children).toHaveLength(1);
    expect((child.disabled as () => boolean)()).toBe(true);
    disabled = false;
    expect((child.disabled as () => boolean)()).toBe(false);
    expect(grouped[0].children!.every((entry) => !entry.children)).toBe(true);
  });

  it("keeps plugin menus intact and never promotes dangerous actions", () => {
    const plugin = { label: "Plugin", children: [{ label: "Run", action: vi.fn() }] };
    const drop = item("contextMenu.dropTable", { variant: "destructive" });
    const input = [plugin, drop];
    const grouped = buildSidebarMenuLayout(input, "table", "grouped", ["contextMenu.dropTable"], t);
    expect(grouped).toContain(plugin);
    expect(grouped).not.toContain(drop);
    expect(grouped.find((entry) => entry.variant === "destructive")?.children).toEqual([drop]);
    expect(input).toEqual([plugin, drop]);
  });

  it("accepts persisted IDs only for known object scopes, including temporarily unavailable actions", () => {
    expect(normalizeSidebarMenuPinnedActions({ table: ["contextMenu.exportData", "contextMenu.exportData", "future.action", "", 42], database: ["diff.title"], unknown: ["contextMenu.viewData"] })).toEqual({ table: ["contextMenu.exportData", "future.action"], database: ["diff.title"] });
    expect(normalizeSidebarMenuPinnedActions(null)).toEqual({});
    expect(sidebarMenuActions([item("common.more", { children: [item("contextMenu.dropTable")] })])).toHaveLength(1);
  });
});
