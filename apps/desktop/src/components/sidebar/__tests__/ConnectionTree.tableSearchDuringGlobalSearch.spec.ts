// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { filterLocallySearchedTables, filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";
import type { TreeNode } from "@/types/database";

const schedulerScript = compileConnectionTreeTestScript(["scheduleSidebarTableSearchRefresh", "scheduleLocalSidebarTableSearchRefresh", "tableSearchFocusRestoreTokenSeq", "tableSearchFocusRestoreTokens"]);
const renderGateScript = compileConnectionTreeTestScript(["shouldRenderSidebarTableSearchControls"]);

function buildSchedulerBindings(isTreeSearchFiltering: boolean) {
  const scheduled: Array<() => void> = [];
  const bindings = {
    isTreeSearchFiltering: { value: isTreeSearchFiltering },
    localTableSearchDebouncer: { cancel: vi.fn() },
    remoteTableSearchDebouncer: { cancel: vi.fn() },
    scheduleExclusiveSidebarTableSearchDebounce: vi.fn((_parentNodeId: string, _primary: unknown, _secondary: unknown, callback: () => void) => scheduled.push(callback)),
    loadLocalTableSearchResults: vi.fn(),
    store: { refreshSidebarTableSearch: vi.fn(async () => undefined) },
  };
  const run = new Function(...Object.keys(bindings), `${schedulerScript}; return { scheduleSidebarTableSearchRefresh, scheduleLocalSidebarTableSearchRefresh };`)(...Object.values(bindings)) as {
    scheduleSidebarTableSearchRefresh: (parentNodeId: string, options?: { focusRestore?: unknown }) => void;
    scheduleLocalSidebarTableSearchRefresh: (parentNodeId: string) => void;
  };
  return { ...bindings, scheduled, run };
}

describe("sidebar local table search stays available during global search filtering (#15148)", () => {
  it("keeps the render gate independent of the tree search filter", () => {
    // 回归绊线：渲染开关不得再引用 isTreeSearchFiltering（旧实现过滤中隐藏输入框）。
    expect(renderGateScript).not.toContain("isTreeSearchFiltering");
    const shouldRender = new Function("settingsStore", `${renderGateScript}; return shouldRenderSidebarTableSearchControls;`)({ editorSettings: { sidebarTableSearchEnabled: true } });
    expect(shouldRender()).toBe(true);
  });

  it("still schedules the local index search while the tree filter is active", () => {
    const view = buildSchedulerBindings(true);
    view.run.scheduleLocalSidebarTableSearchRefresh("db1:tables");
    expect(view.scheduleExclusiveSidebarTableSearchDebounce).toHaveBeenCalledTimes(1);
    expect(view.localTableSearchDebouncer.cancel).not.toHaveBeenCalled();

    for (const callback of view.scheduled.splice(0)) callback();
    expect(view.loadLocalTableSearchResults).toHaveBeenCalledWith("db1:tables", false, undefined);
  });

  it("still schedules the remote table search while the tree filter is active", () => {
    const view = buildSchedulerBindings(true);
    view.run.scheduleSidebarTableSearchRefresh("db1");
    expect(view.scheduleExclusiveSidebarTableSearchDebounce).toHaveBeenCalledTimes(1);

    for (const callback of view.scheduled.splice(0)) callback();
    expect(view.store.refreshSidebarTableSearch).toHaveBeenCalledWith("db1");
  });
});

describe("local table search composes with the global tree filter", () => {
  it("narrows tables inside a globally matched database subtree", () => {
    const tables: TreeNode = {
      id: "db1:tables",
      connectionId: "conn",
      database: "db1",
      type: "group-tables",
      label: "表",
      children: [
        { id: "t1", connectionId: "conn", database: "db1", type: "table", label: "app_user" },
        { id: "t2", connectionId: "conn", database: "db1", type: "table", label: "dim_store" },
      ],
    };
    const database: TreeNode = { id: "db1", connectionId: "conn", type: "database", label: "app_数仓", children: [tables] };
    const root: TreeNode = { id: "conn", connectionId: "conn", type: "connection", label: "开发环境", children: [database] };

    const locallyFiltered = filterLocallySearchedTables([root], { enabled: true, queries: { "db1:tables": "user" }, indexedResults: {} });
    const globallyFiltered = filterSidebarTree(locallyFiltered, "数仓", new Set());

    const connection = globallyFiltered[0]!;
    const groupedTables = connection.children?.[0]?.children?.[0];
    expect(groupedTables?.type).toBe("group-tables");
    expect(groupedTables?.children?.map((child) => child.label)).toEqual(["app_user"]);
  });
});
