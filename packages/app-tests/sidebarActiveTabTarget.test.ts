import { strict as assert } from "node:assert";
import { test } from "vitest";
import { activeTabSidebarTarget, findSidebarNodeForActiveTab, scrollTopForSidebarNode, shouldScrollActiveSidebarSelection } from "../../apps/desktop/src/lib/sidebarActiveTabTarget.ts";
import type { FlatTreeNode } from "../../apps/desktop/src/composables/useFlatTree.ts";
import type { QueryTab, TreeNode } from "../../apps/desktop/src/types/database.ts";

function flat(node: TreeNode, depth = 0): FlatTreeNode {
  return { id: node.id, node, depth, type: node.type };
}

test("data tabs target the matching visible table or view node", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "users",
    connectionId: "conn-1",
    database: "app",
    sql: "",
    isExecuting: false,
    mode: "data",
    tableMeta: { schema: "public", tableName: "users", columns: [], primaryKeys: [] },
  };
  const users: TreeNode = {
    id: "users-node",
    label: "users",
    type: "table",
    connectionId: "conn-1",
    database: "app",
    schema: "public",
  };

  assert.deepEqual(activeTabSidebarTarget(tab), {
    type: "table",
    connectionId: "conn-1",
    database: "app",
    schema: "public",
    tableName: "users",
  });
  assert.equal(findSidebarNodeForActiveTab(tab, [flat(users)])?.id, "users-node");
});

test("mongo tabs target the matching visible collection node", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "app.events",
    connectionId: "conn-1",
    database: "app",
    sql: "events",
    isExecuting: false,
    mode: "mongo",
  };
  const collection: TreeNode = {
    id: "events-node",
    label: "events",
    type: "mongo-collection",
    connectionId: "conn-1",
    database: "app",
  };

  assert.equal(findSidebarNodeForActiveTab(tab, [flat(collection)])?.id, "events-node");
});

test("saved SQL tabs target the matching visible saved SQL file node", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "report.sql",
    connectionId: "conn-1",
    database: "app",
    sql: "select 1",
    savedSqlId: "sql-1",
    isExecuting: false,
    mode: "query",
  };
  const file: TreeNode = { id: "file-node", label: "report.sql", type: "saved-sql-file", savedSqlId: "sql-1" };

  assert.deepEqual(activeTabSidebarTarget(tab), { type: "saved-sql-file", savedSqlId: "sql-1" });
  assert.equal(findSidebarNodeForActiveTab(tab, [flat(file)])?.id, "file-node");
});

test("query tabs target their database node in the sidebar", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "Query 1",
    connectionId: "conn-1",
    database: "app",
    sql: "select 1",
    isExecuting: false,
    mode: "query",
  };

  assert.deepEqual(activeTabSidebarTarget(tab), {
    type: "query-context",
    connectionId: "conn-1",
    database: "app",
    schema: undefined,
  });
});

test("query tabs without connectionId have no sidebar target", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "Query 1",
    connectionId: "",
    database: "",
    sql: "select 1",
    isExecuting: false,
    mode: "query",
  };

  assert.equal(activeTabSidebarTarget(tab), null);
});
test("sidebar target lookup only uses the current flat visible tree", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "users",
    connectionId: "conn-1",
    database: "app",
    sql: "",
    isExecuting: false,
    mode: "data",
    tableMeta: { tableName: "users", columns: [], primaryKeys: [] },
  };
  const collapsedParentOnly: TreeNode = {
    id: "db-node",
    label: "app",
    type: "database",
    connectionId: "conn-1",
    database: "app",
  };

  assert.equal(findSidebarNodeForActiveTab(tab, [flat(collapsedParentOnly)]), null);
});

test("sidebar node scrolling keeps visible rows in place and reveals hidden rows", () => {
  assert.equal(scrollTopForSidebarNode({ index: 2, currentScrollTop: 0, viewportHeight: 140 }), 0);
  assert.equal(scrollTopForSidebarNode({ index: 20, currentScrollTop: 0, viewportHeight: 140 }), 448);
  assert.equal(scrollTopForSidebarNode({ index: 1, currentScrollTop: 280, viewportHeight: 140 }), 28);
});

test("active sidebar selection only scrolls on tab or setting changes", () => {
  assert.equal(
    shouldScrollActiveSidebarSelection({
      activeTabId: "tab-1",
      previousActiveTabId: "tab-1",
      autoSelectEnabled: true,
      previousAutoSelectEnabled: true,
    }),
    false,
  );
  assert.equal(
    shouldScrollActiveSidebarSelection({
      activeTabId: "tab-2",
      previousActiveTabId: "tab-1",
      autoSelectEnabled: true,
      previousAutoSelectEnabled: true,
    }),
    true,
  );
  assert.equal(
    shouldScrollActiveSidebarSelection({
      activeTabId: "tab-1",
      previousActiveTabId: "tab-1",
      autoSelectEnabled: true,
      previousAutoSelectEnabled: false,
    }),
    true,
  );
});
