import { strict as assert } from "node:assert";
import { test } from "vitest";
import { collapseExpandedTreeNodes } from "../../apps/desktop/src/lib/sidebar/sidebarTreeCollapse.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

test("collapseExpandedTreeNodes collapses all expanded descendants", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn",
      label: "conn",
      type: "connection",
      isExpanded: true,
      children: [
        {
          id: "db",
          label: "db",
          type: "database",
          isExpanded: true,
          children: [
            { id: "tables", label: "Tables", type: "group-tables", isExpanded: false },
            { id: "views", label: "Views", type: "group-views", isExpanded: true },
          ],
        },
      ],
    },
    { id: "closed", label: "closed", type: "connection", isExpanded: false },
  ];

  assert.equal(collapseExpandedTreeNodes(nodes), 3);
  assert.equal(nodes[0].isExpanded, false);
  assert.equal(nodes[0].children?.[0]?.isExpanded, false);
  assert.equal(nodes[0].children?.[0]?.children?.[0]?.isExpanded, false);
  assert.equal(nodes[0].children?.[0]?.children?.[1]?.isExpanded, false);
  assert.equal(nodes[1].isExpanded, false);
});

test("collapseExpandedTreeNodes returns zero when nothing is expanded", () => {
  const nodes: TreeNode[] = [{ id: "conn", label: "conn", type: "connection", isExpanded: false }];

  assert.equal(collapseExpandedTreeNodes(nodes), 0);
  assert.equal(nodes[0].isExpanded, false);
});
