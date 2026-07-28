import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createFlatTreeIndex, flattenTree } from "../../apps/desktop/src/composables/useFlatTree.ts";
import { filterSidebarTree } from "../../apps/desktop/src/lib/sidebar/sidebarSearchTree.ts";
import { scrollTopForSidebarNode } from "../../apps/desktop/src/lib/sidebar/sidebarActiveTabTarget.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

function largeTree(): TreeNode[] {
  return Array.from({ length: 5 }, (_, connectionIndex) => ({
    id: `connection-${connectionIndex}`,
    label: `connection-${connectionIndex}`,
    type: "connection" as const,
    isExpanded: true,
    children: Array.from({ length: 5 }, (_, databaseIndex) => ({
      id: `connection-${connectionIndex}:database-${databaseIndex}`,
      label: `database-${databaseIndex}`,
      type: "database" as const,
      connectionId: `connection-${connectionIndex}`,
      database: `database-${databaseIndex}`,
      isExpanded: true,
      children: Array.from({ length: 500 }, (_, tableIndex) => ({
        id: `connection-${connectionIndex}:database-${databaseIndex}:table-${tableIndex}`,
        label: `table_${connectionIndex}_${databaseIndex}_${tableIndex}`,
        type: "table" as const,
        connectionId: `connection-${connectionIndex}`,
        database: `database-${databaseIndex}`,
      })),
    })),
  }));
}

test("large sidebar tree keeps expansion, filtering and scroll indexes consistent", () => {
  const tree = largeTree();
  const flat = flattenTree(tree);
  const index = createFlatTreeIndex(flat, {
    isSelectable: () => true,
    isBoundary: (type) => type === "connection" || type === "connection-group",
    isDatabaseContainer: (type) => type === "database",
    isSchemaContainer: (type) => type === "schema",
  });

  assert.equal(flat.length, 12_530);
  const targetId = "connection-4:database-4:table-499";
  const targetIndex = index.flatNodeIndexById.get(targetId);
  assert.equal(typeof targetIndex, "number");
  assert.equal(index.nodeById.get(targetId)?.label, "table_4_4_499");
  assert.ok(scrollTopForSidebarNode({ index: targetIndex!, currentScrollTop: 0, viewportHeight: 560 }) > 0);

  const filtered = flattenTree(filterSidebarTree(tree, "table_4_4_499", new Set()));
  assert.deepEqual(
    filtered.map((item) => item.id),
    ["connection-4", "connection-4:database-4", targetId],
  );
});
