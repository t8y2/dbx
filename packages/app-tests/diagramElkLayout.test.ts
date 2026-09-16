import { strict as assert } from "node:assert";
import { test } from "vitest";
import { computeLayoutWithLayers } from "../../apps/desktop/src/lib/diagram/elk-layout.ts";
import type { DiagramEdge, DiagramLayer, DiagramNode } from "../../apps/desktop/src/types/diagram.ts";
import type { DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";

function table(name: string): DiagramTable {
  return {
    name,
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
    ],
    foreignKeys: [],
  };
}

test("computeLayoutWithLayers returns finite coords and layerLayouts for nested auto layer", async () => {
  const nodes: DiagramNode[] = [
    { id: "users", type: "table", position: { x: 0, y: 0 }, data: { table: table("users") } },
    { id: "orders", type: "table", position: { x: 0, y: 0 }, data: { table: table("orders") } },
  ];
  const edges: DiagramEdge[] = [
    { id: "e1", source: "orders", target: "users", sourceHandle: "right", targetHandle: "left-target" },
  ];
  const layers: DiagramLayer[] = [
    {
      id: "layer-1",
      name: "Core",
      color: "#3b82f6",
      tableNames: ["users", "orders"],
      collapsed: false,
      visible: true,
      layoutMode: "auto",
      position: { x: 0, y: 0 },
      width: 240,
      height: 52,
    },
  ];

  const result = await computeLayoutWithLayers(nodes, edges, layers);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.layerLayouts.length, 1);
  assert.equal(result.layerLayouts[0].layerId, "layer-1");
  assert.ok(Number.isFinite(result.layerLayouts[0].x));
  assert.ok(Number.isFinite(result.layerLayouts[0].width));
  assert.ok(result.layerLayouts[0].width > 0);
  assert.ok(result.layerLayouts[0].height > 0);

  for (const node of result.nodes) {
    assert.ok(Number.isFinite(node.position.x));
    assert.ok(Number.isFinite(node.position.y));
  }

  const layer = result.layerLayouts[0];
  for (const node of result.nodes) {
    assert.ok(node.position.x >= layer.x - 1, `${node.id} x outside layer`);
    assert.ok(node.position.y >= layer.y - 1, `${node.id} y outside layer`);
    assert.ok(node.position.x <= layer.x + layer.width + 1, `${node.id} exceeds layer width`);
    assert.ok(node.position.y <= layer.y + layer.height + 1, `${node.id} exceeds layer height`);
  }
});
