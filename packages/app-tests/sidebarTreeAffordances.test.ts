import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { syncSidebarTreeNodeExpansion } from "../../apps/desktop/src/lib/sidebar/sidebarTreeExpansion.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");
const runtimeHost = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
const connectionStore = readFileSync("apps/desktop/src/stores/connectionStore.ts", "utf8");

test("sidebar rows retain database-specific node affordances", () => {
  for (const nodeType of ["connection", "database", "schema", "table", "column", "mongo-db", "mongo-collection", "redis-db", "nacos-namespace", "mq-tenant"]) {
    const sources = `${treeItem}\n${runtimeHost}`;
    assert.ok(sources.includes(`node.type === "${nodeType}"`) || sources.includes(`node.type === '${nodeType}'`), nodeType);
  }
  assert.match(treeItem, /@dblclick="onDoubleClick"/);
  assert.match(treeItem, /@keydown="onKeydown"/);
  assert.match(treeItem, /@mousedown="onRowMouseDown"/);
  assert.match(treeItem, /@contextmenu="onTreeItemContextMenu"/);
});

test("complex tree changes retain the full rebuild fallback", () => {
  assert.match(connectionTree, /const filteredNodes = computed/);
  assert.match(connectionTree, /filterSidebarTree\(/);
  assert.match(connectionTree, /const flatNodes = computed<FlatTreeNode\[]>/);
  assert.match(connectionTree, /flattenTree\(filteredNodes\.value\)/);
  assert.match(connectionTree, /watch\(flatNodes,/);
  assert.doesNotMatch(connectionTree, /treeScrollerRef\.value\?\.(?:forceUpdate|updateVisibleItems)/);
  assert.match(connectionTree, /@node-toggled="onNodeToggled"/);
});

test("tree toggles synchronize filtered node clones with the live sidebar tree", () => {
  const expandedConnection: TreeNode = {
    id: "connection-1",
    label: "Connection 1",
    type: "connection",
    connectionId: "connection-1",
    isExpanded: true,
  };
  const collapsedClone: TreeNode = { ...expandedConnection, isExpanded: false };
  const collapsedConnection: TreeNode = {
    id: "connection-2",
    label: "Connection 2",
    type: "connection",
    connectionId: "connection-2",
    isExpanded: false,
  };
  const expandedClone: TreeNode = { ...collapsedConnection, isExpanded: true };

  assert.equal(syncSidebarTreeNodeExpansion([expandedConnection], collapsedClone, false), true);
  assert.equal(expandedConnection.isExpanded, false);
  assert.equal(syncSidebarTreeNodeExpansion([collapsedConnection], expandedClone, true), true);
  assert.equal(collapsedConnection.isExpanded, true);
  assert.equal(syncSidebarTreeNodeExpansion([expandedConnection], expandedConnection, true), false);
});

test("async tree expansion does not restore a stale rendered clone state", () => {
  const liveDatabase: TreeNode = {
    id: "connection-1:database-1",
    label: "Database 1",
    type: "database",
    connectionId: "connection-1",
    database: "database-1",
    isExpanded: false,
    children: [],
  };
  const staleRenderedClone: TreeNode = { ...liveDatabase, children: [] };

  liveDatabase.isExpanded = true;

  assert.equal(syncSidebarTreeNodeExpansion([liveDatabase], staleRenderedClone, true), false);
  assert.equal(liveDatabase.isExpanded, true);
});

test("local table search preserves live expansion state", () => {
  assert.match(connectionTree, /return \{ \.\.\.node, children: matchingChildren \};/);
  assert.doesNotMatch(connectionTree, /children: matchingChildren,\s*isExpanded:\s*true/);
  assert.match(connectionTree, /function onNodeToggled\(node: TreeNode, wasExpanded: boolean\) \{\s*if \(isTreeSearchFiltering\.value\) return;\s*syncSidebarTreeNodeExpansion\(store\.treeNodes, node, !wasExpanded\)/);
});

test("tree rebuilds keep a context menu only while its target row remains visible", () => {
  assert.match(connectionTree, /nodes\.find\(\(\{ node \}\) => matchesSidebarActionTarget\(node, contextMenuTarget\)\)\?\.node/);
  assert.match(connectionTree, /if \(!visibleContextMenuTarget \|\| visibleContextMenuTarget\.valid === false\)/);
});

test("programmable object groups use the shared metadata loader", () => {
  assert.match(runtimeHost, /const databaseObjectGroup = !!objectTypesForGroupNode\(node\.type\)/);
  assert.match(connectionStore, /else if \(objectTypesForGroupNode\(node\.type\)\) \{\s*await loadObjectGroupChildren\(node, options\);/);
});
