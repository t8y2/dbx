import { strict as assert } from "node:assert";
import { test } from "vitest";
import { syncSidebarTreeNodeExpansion } from "../../apps/desktop/src/lib/sidebar/sidebarTreeExpansion.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

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
