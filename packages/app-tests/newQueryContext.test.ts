import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveNewQueryTarget } from "../../apps/desktop/src/lib/sql/newQueryContext.ts";
import type { ConnectionConfig, QueryTab, TreeNode } from "../../apps/desktop/src/types/database.ts";

function connection(id: string, database = ""): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
    database,
  };
}

function queryTab(connectionId: string, database: string, mode: QueryTab["mode"] = "data"): QueryTab {
  return {
    id: `${connectionId}-${database}`,
    title: "users",
    connectionId,
    database,
    sql: "",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode,
  };
}

test("new query target prefers the active data tab context", () => {
  const target = resolveNewQueryTarget({
    activeTab: queryTab("conn-data", "analytics", "data"),
    selectedTreeNode: {
      id: "conn-tree:reporting",
      label: "reporting",
      type: "database",
      connectionId: "conn-tree",
      database: "reporting",
    },
    activeConnectionId: "conn-active",
    connections: [connection("conn-active"), connection("conn-data"), connection("conn-tree")],
  });

  assert.deepEqual(target, {
    connectionId: "conn-data",
    database: "analytics",
    schema: undefined,
    catalog: undefined,
    shouldRefreshDefaultDatabase: false,
  });
});

test("new query target uses the selected sidebar node when there is no active tab", () => {
  const selectedTreeNode: TreeNode = {
    id: "conn-tree:reporting:public:users",
    label: "users",
    type: "table",
    connectionId: "conn-tree",
    database: "reporting",
    schema: "public",
  };

  const target = resolveNewQueryTarget({
    activeTab: undefined,
    selectedTreeNode,
    activeConnectionId: "conn-active",
    connections: [connection("conn-active"), connection("conn-tree")],
  });

  assert.deepEqual(target, {
    connectionId: "conn-tree",
    database: "reporting",
    schema: "public",
    catalog: undefined,
    shouldRefreshDefaultDatabase: false,
  });
});

test("new query target prefers the selected sidebar node after sidebar focus", () => {
  const target = resolveNewQueryTarget({
    activeTab: queryTab("conn-data", "analytics", "data"),
    selectedTreeNode: {
      id: "conn-tree:reporting:public:users",
      label: "users",
      type: "table",
      connectionId: "conn-tree",
      database: "reporting",
    },
    activeConnectionId: "conn-active",
    connections: [connection("conn-active"), connection("conn-data"), connection("conn-tree")],
    preferredSource: "sidebar",
  });

  assert.deepEqual(target, {
    connectionId: "conn-tree",
    database: "reporting",
    schema: undefined,
    catalog: undefined,
    shouldRefreshDefaultDatabase: false,
  });
});

test("new query target refreshes default database for connection-only sidebar nodes", () => {
  const target = resolveNewQueryTarget({
    activeTab: undefined,
    selectedTreeNode: { id: "conn-tree", label: "conn-tree", type: "connection", connectionId: "conn-tree" },
    activeConnectionId: "conn-active",
    connections: [connection("conn-active"), connection("conn-tree", "saved_default")],
  });

  assert.deepEqual(target, {
    connectionId: "conn-tree",
    database: "saved_default",
    schema: undefined,
    catalog: undefined,
    shouldRefreshDefaultDatabase: true,
  });
});
