import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

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
});

test("programmable object groups use the shared metadata loader", () => {
  assert.match(runtimeHost, /const databaseObjectGroup = !!objectTypesForGroupNode\(node\.type\)/);
  assert.match(connectionStore, /else if \(objectTypesForGroupNode\(node\.type\)\) \{\s*await loadObjectGroupChildren\(node, options\);/);
});
