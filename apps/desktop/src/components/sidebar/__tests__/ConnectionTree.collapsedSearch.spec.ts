import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSidebarSearchTasks } from "../sidebarSearchTaskRunner";

const source = readFileSync(new URL("../ConnectionTree.vue", import.meta.url), "utf8");

describe("ConnectionTree global search loading", () => {
  it("discovers collapsed database and schema containers before searching object groups", () => {
    expect(source).toContain("function isSidebarSearchContainer(node: TreeNode)");
    // A collapsed database already holds the saved-SQL root, so it has children
    // even when its object groups were never fetched; the search has to look for
    // a searchable group instead of an empty child list.
    expect(source).toMatch(/isSidebarSearchContainer\(node\) && needsSidebarObjectGroupDiscovery\(node, searchableObjectGroupTypes\)/);
    expect(source).not.toMatch(/isSidebarSearchContainer\(node\) && !node\.children\?\.length/);
    expect(source).toContain("store.loadTreeNodeChildren(node, { force: true, expectedSidebarSearchQuery: store.sidebarSearchQuery })");
    expect(source).toContain("searchExpansionState.markFiltered(node.id, wasCollapsed)");
    expect(source).toMatch(/if \(refreshedNodeIds && node\.children\) \{[\s\S]*?searchableObjectGroupTypes\.has\(child\.type\)/);
  });

  it("deduplicates each node within a search round and restores tracked nodes", () => {
    expect(source).toContain("const scheduledNodeIds = new Set<string>();");
    expect(source).toContain("while (deferredSearchQuery.value === query && store.sidebarSearchQuery === query)");
    expect(source).toContain("const restoreTasks = !newQuery && oldQuery ? restoreTrackedSearchTargets() : [];");
    expect(source).toContain("if (shouldCollapse) node.isExpanded = false;");
    expect(source).toContain("store.discardFilteredTreeNodeChildren(node.id);");
  });

  it("restores the pre-search children of an expanded group instead of reloading page one", () => {
    // Clearing a remote search must put back the pages the user had loaded
    // through "load more"; only an uncaptured group falls back to a reload.
    expect(source).toContain("} else if (!store.restoreFilteredObjectGroupChildren(node)) {");
    expect(source).toMatch(/restoreFilteredObjectGroupChildren\(node\)\) \{[\s\S]*?tasks\.push\(\(\) => store\.loadObjectGroupChildren\(node, \{ force: true \}\)\);/);
  });

  it("limits concurrent metadata loads without dropping a task", async () => {
    let activeTasks = 0;
    let maximumActiveTasks = 0;
    let completedTasks = 0;
    const tasks = Array.from({ length: 8 }, () => async () => {
      activeTasks += 1;
      maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeTasks -= 1;
      completedTasks += 1;
    });

    await runSidebarSearchTasks(tasks, 2);

    expect(maximumActiveTasks).toBe(2);
    expect(completedTasks).toBe(tasks.length);
  });
});
