import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_SEARCH_AUTO_LOAD_CONCURRENCY, collectSidebarSearchAutoLoadTargets, runSidebarSearchAutoLoad, shouldAutoLoadForSidebarSearch, sidebarSearchAutoLoadKind } from "@/lib/sidebar/sidebarSearchAutoLoad";
import type { TreeNode, TreeNodeType } from "@/types/database";

function node(overrides: Partial<TreeNode> & Pick<TreeNode, "id" | "type">): TreeNode {
  return { label: overrides.id, ...overrides };
}

/** connection -> database, the shape a user sees with the connection open. */
function connectionWithDatabases(connectionId: string, databases: string[]): TreeNode {
  return node({
    id: connectionId,
    type: "connection",
    connectionId,
    isExpanded: true,
    children: databases.map((database) =>
      node({
        id: `${connectionId}:${database}`,
        type: "database",
        connectionId,
        database,
        isExpanded: false,
        children: [],
      }),
    ),
  });
}

/** Grouped display: a loaded database exposes empty object-group placeholders. */
function objectGroupPlaceholders(databaseNodeId: string, connectionId: string, database: string, schema?: string): TreeNode[] {
  return (["group-tables", "group-views"] as const).map((type) =>
    node({
      id: `${databaseNodeId}:__${type}`,
      type,
      connectionId,
      database,
      schema,
      isExpanded: false,
      children: [],
    }),
  );
}

function tableNode(parentId: string, connectionId: string, database: string, name: string): TreeNode {
  return node({ id: `${parentId}:${name}`, label: name, type: "table", connectionId, database, tableName: name });
}

type Harness = {
  roots: TreeNode[];
  loaded: Set<string>;
  loadChildren: (target: TreeNode) => Promise<void>;
  options: () => Parameters<typeof runSidebarSearchAutoLoad>[0];
};

/**
 * Mirrors the store contract the component wires in: a load marks the node id as
 * loaded, attaches children, and force-expands the node the way the real
 * metadata loaders do.
 */
function harness(roots: TreeNode[], childrenFor: (target: TreeNode) => TreeNode[], hooks: { onLoad?: (target: TreeNode) => Promise<void> | void } = {}): Harness {
  const loaded = new Set<string>();
  const loadChildren = async (target: TreeNode) => {
    await hooks.onLoad?.(target);
    target.children = childrenFor(target);
    target.isExpanded = true;
    loaded.add(target.id);
  };
  const findById = (nodes: readonly TreeNode[], id: string): TreeNode | null => {
    for (const current of nodes) {
      if (current.id === id) return current;
      const found = current.children ? findById(current.children, id) : null;
      if (found) return found;
    }
    return null;
  };
  return {
    roots,
    loaded,
    loadChildren,
    options: () => ({
      getTreeNodes: () => roots,
      isConnected: () => true,
      isChildrenLoaded: (nodeId: string) => loaded.has(nodeId),
      loadChildren,
      liveNode: (nodeId: string) => findById(roots, nodeId),
    }),
  };
}

describe("sidebarSearchAutoLoadKind", () => {
  it("classifies the levels that gate table visibility", () => {
    expect(sidebarSearchAutoLoadKind(node({ id: "d", type: "database", database: "app" }))).toBe("container");
    expect(sidebarSearchAutoLoadKind(node({ id: "m", type: "mongo-db", database: "app" }))).toBe("container");
    expect(sidebarSearchAutoLoadKind(node({ id: "v", type: "vector-database", database: "app" }))).toBe("container");
    expect(sidebarSearchAutoLoadKind(node({ id: "s", type: "schema", schema: "public" }))).toBe("schema");
    expect(sidebarSearchAutoLoadKind(node({ id: "g", type: "group-tables" }))).toBe("object-group");
  });

  it("ignores nodes that are not loadable search containers", () => {
    // Missing database/schema context means the store has nothing to query.
    expect(sidebarSearchAutoLoadKind(node({ id: "d", type: "database" }))).toBeNull();
    expect(sidebarSearchAutoLoadKind(node({ id: "s", type: "schema" }))).toBeNull();
    expect(sidebarSearchAutoLoadKind(node({ id: "c", type: "connection" }))).toBeNull();
    expect(sidebarSearchAutoLoadKind(node({ id: "t", type: "table" }))).toBeNull();
    // Procedures/functions are deliberately excluded to bound the metadata cost.
    expect(sidebarSearchAutoLoadKind(node({ id: "g", type: "group-procedures" }))).toBeNull();
  });
});

describe("collectSidebarSearchAutoLoadTargets", () => {
  it("collects collapsed databases across every open connection", () => {
    const roots = [connectionWithDatabases("c1", ["app", "logs"]), connectionWithDatabases("c2", ["shop"])];

    const targets = collectSidebarSearchAutoLoadTargets(roots, { isConnected: () => true, isChildrenLoaded: () => false });

    expect(targets.map((target) => target.id)).toEqual(["c1:app", "c1:logs", "c2:shop"]);
  });

  it("skips databases whose children are already in memory", () => {
    const roots = [connectionWithDatabases("c1", ["app", "logs"])];

    const targets = collectSidebarSearchAutoLoadTargets(roots, { isConnected: () => true, isChildrenLoaded: (nodeId) => nodeId === "c1:app" });

    expect(targets.map((target) => target.id)).toEqual(["c1:logs"]);
  });

  it("skips disconnected connections instead of walking their stale subtree", () => {
    const roots = [connectionWithDatabases("c1", ["app"]), connectionWithDatabases("c2", ["shop"])];

    const targets = collectSidebarSearchAutoLoadTargets(roots, { isConnected: (connectionId) => connectionId === "c1", isChildrenLoaded: () => false });

    expect(targets.map((target) => target.id)).toEqual(["c1:app"]);
  });

  it("honours the skip list so a retried round only sees new levels", () => {
    const roots = [connectionWithDatabases("c1", ["app", "logs"])];

    const targets = collectSidebarSearchAutoLoadTargets(roots, { isConnected: () => true, isChildrenLoaded: () => false }, new Set(["c1:app"]));

    expect(targets.map((target) => target.id)).toEqual(["c1:logs"]);
  });
});

describe("shouldAutoLoadForSidebarSearch", () => {
  it("requires a non-blank query", () => {
    expect(shouldAutoLoadForSidebarSearch("")).toBe(false);
    expect(shouldAutoLoadForSidebarSearch("   ")).toBe(false);
    expect(shouldAutoLoadForSidebarSearch("users")).toBe(true);
  });

  it("loads when the scope filter targets nodes that only exist after a load", () => {
    const scopes = (types: TreeNodeType[]) => new Set<TreeNodeType>(types);

    expect(shouldAutoLoadForSidebarSearch("users", scopes(["table"]))).toBe(true);
    expect(shouldAutoLoadForSidebarSearch("users", scopes(["view"]))).toBe(true);
    expect(shouldAutoLoadForSidebarSearch("users", scopes(["schema"]))).toBe(true);
    expect(shouldAutoLoadForSidebarSearch("users", scopes(["mongo-collection"]))).toBe(true);
  });

  it("skips loading when the scope filter only targets already-visible levels", () => {
    // Connection/database rows are present without any metadata read, so
    // preloading tables for them would be wasted round-trips.
    expect(shouldAutoLoadForSidebarSearch("app", new Set<TreeNodeType>(["connection", "database"]))).toBe(false);
  });
});

describe("runSidebarSearchAutoLoad", () => {
  it("loads collapsed databases so their tables become searchable", async () => {
    const roots = [connectionWithDatabases("c1", ["app"])];
    const test = harness(roots, (target) => [tableNode(target.id, "c1", "app", "users")]);

    const result = await runSidebarSearchAutoLoad(test.options());

    expect(result.loadedNodeIds).toEqual(["c1:app"]);
    expect(roots[0].children?.[0].children?.map((child) => child.label)).toEqual(["users"]);
  });

  it("keeps auto-loaded databases collapsed even though the store force-expands them", async () => {
    // Regression guard: leaking the forced expansion left every database open
    // once the query was cleared — the endless directory this feature fixes.
    const roots = [connectionWithDatabases("c1", ["app", "logs"])];
    const test = harness(roots, (target) => [tableNode(target.id, "c1", "app", "users")]);

    await runSidebarSearchAutoLoad(test.options());

    expect(roots[0].children?.map((child) => child.isExpanded)).toEqual([false, false]);
    // The connection the user opened themselves stays open.
    expect(roots[0].isExpanded).toBe(true);
  });

  it("preserves an expansion the user had already made", async () => {
    const roots = [connectionWithDatabases("c1", ["app"])];
    roots[0].children![0].isExpanded = true;
    const test = harness(roots, (target) => [tableNode(target.id, "c1", "app", "users")]);

    await runSidebarSearchAutoLoad(test.options());

    expect(roots[0].children?.[0].isExpanded).toBe(true);
  });

  it("descends into object groups so grouped display finds tables", async () => {
    // Grouped display (the default) hands back empty group placeholders, so
    // loading only the database would never surface a single table.
    const roots = [connectionWithDatabases("c1", ["app"])];
    const test = harness(roots, (target) => (target.type === "database" ? objectGroupPlaceholders(target.id, "c1", "app") : [tableNode(target.id, "c1", "app", "users")]));

    const result = await runSidebarSearchAutoLoad(test.options());

    expect(result.loadedNodeIds).toEqual(["c1:app", "c1:app:__group-tables", "c1:app:__group-views"]);
    const groups = roots[0].children?.[0].children ?? [];
    expect(groups.map((group) => group.children?.map((child) => child.label))).toEqual([["users"], ["users"]]);
    expect(groups.every((group) => group.isExpanded === false)).toBe(true);
  });

  it("descends through schemas into their table groups", async () => {
    const roots = [connectionWithDatabases("c1", ["app"])];
    const test = harness(roots, (target) => {
      if (target.type === "database") return [node({ id: `${target.id}:public`, type: "schema", connectionId: "c1", database: "app", schema: "public", isExpanded: false, children: [] })];
      if (target.type === "schema") return objectGroupPlaceholders(target.id, "c1", "app", "public");
      return [tableNode(target.id, "c1", "app", "users")];
    });

    const result = await runSidebarSearchAutoLoad(test.options());

    expect(result.loadedNodeIds).toEqual(["c1:app", "c1:app:public", "c1:app:public:__group-tables", "c1:app:public:__group-views"]);
    const schema = roots[0].children?.[0].children?.[0];
    expect(schema?.isExpanded).toBe(false);
    expect(schema?.children?.[0].children?.map((child) => child.label)).toEqual(["users"]);
  });

  it("caps concurrent metadata loads", async () => {
    const roots = [
      connectionWithDatabases(
        "c1",
        Array.from({ length: 12 }, (_, index) => `db${index}`),
      ),
    ];
    let inFlight = 0;
    let peakInFlight = 0;
    const test = harness(roots, () => [], {
      onLoad: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      },
    });

    await runSidebarSearchAutoLoad({ ...test.options(), concurrency: 3 });

    expect(peakInFlight).toBe(3);
    expect(test.loaded.size).toBe(12);
  });

  it("defaults to a bounded pool", () => {
    expect(SIDEBAR_SEARCH_AUTO_LOAD_CONCURRENCY).toBeLessThanOrEqual(8);
  });

  it("stops loading once the query is superseded", async () => {
    const roots = [connectionWithDatabases("c1", ["app", "logs", "shop"])];
    let cancelled = false;
    const test = harness(roots, () => [], {
      onLoad: () => {
        // The user kept typing: everything after the first load is stale work.
        cancelled = true;
      },
    });

    const result = await runSidebarSearchAutoLoad({ ...test.options(), concurrency: 1, isCancelled: () => cancelled });

    expect(result.cancelled).toBe(true);
    expect(result.loadedNodeIds).toEqual(["c1:app"]);
  });

  it("does not start when already cancelled", async () => {
    const roots = [connectionWithDatabases("c1", ["app"])];
    const test = harness(roots, () => []);
    const loadChildren = vi.fn(test.loadChildren);

    const result = await runSidebarSearchAutoLoad({ ...test.options(), loadChildren, isCancelled: () => true });

    expect(loadChildren).not.toHaveBeenCalled();
    expect(result).toEqual({ loadedNodeIds: [], cancelled: true });
  });

  it("keeps searching the reachable databases when one fails", async () => {
    const roots = [connectionWithDatabases("c1", ["broken", "app"])];
    const test = harness(roots, (target) => [tableNode(target.id, "c1", "app", "users")], {
      onLoad: (target) => {
        if (target.database === "broken") throw new Error("connection reset");
      },
    });

    const result = await runSidebarSearchAutoLoad({ ...test.options(), concurrency: 1 });

    expect(result.loadedNodeIds).toEqual(["c1:app"]);
    expect(roots[0].children?.[1].children?.map((child) => child.label)).toEqual(["users"]);
  });

  it("never retries a node that failed", async () => {
    const roots = [connectionWithDatabases("c1", ["broken"])];
    const attempts: string[] = [];
    const test = harness(roots, () => [], {
      onLoad: (target) => {
        attempts.push(target.id);
        throw new Error("connection reset");
      },
    });

    await runSidebarSearchAutoLoad(test.options());

    expect(attempts).toEqual(["c1:broken"]);
  });

  it("restores expansion on the live node when the store replaced the object", async () => {
    // Loads can rebuild the tree; the flag has to be restored on whatever node
    // is currently mounted, not on the stale reference we started from.
    const roots = [connectionWithDatabases("c1", ["app"])];
    const stale = roots[0].children![0];
    const replacement = node({ id: stale.id, type: "database", connectionId: "c1", database: "app", isExpanded: true, children: [] });
    const test = harness(roots, () => [], {
      onLoad: () => {
        roots[0].children = [replacement];
      },
    });

    await runSidebarSearchAutoLoad(test.options());

    expect(replacement.isExpanded).toBe(false);
  });

  it("does nothing when every level is already loaded", async () => {
    const roots = [connectionWithDatabases("c1", ["app"])];
    const test = harness(roots, () => []);
    const loadChildren = vi.fn(test.loadChildren);

    const result = await runSidebarSearchAutoLoad({ ...test.options(), isChildrenLoaded: () => true, loadChildren });

    expect(loadChildren).not.toHaveBeenCalled();
    expect(result).toEqual({ loadedNodeIds: [], cancelled: false });
  });
});
