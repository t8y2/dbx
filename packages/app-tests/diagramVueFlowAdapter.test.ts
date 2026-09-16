import { strict as assert } from "node:assert";
import { beforeEach, test } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useLayerStore } from "../../apps/desktop/src/lib/diagram/layer-store.ts";
import {
  isTableCanvasVisible,
  toVueFlowEdges,
  toVueFlowNodes,
} from "../../apps/desktop/src/lib/diagram/vue-flow-adapter.ts";
import type { DiagramRelationship, DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";
import type { DiagramLayer } from "../../apps/desktop/src/types/diagram.ts";

function table(name: string): DiagramTable {
  return { name, columns: [], foreignKeys: [] };
}

function layer(partial: Partial<DiagramLayer> & { id: string; name: string; tableNames: string[] }): DiagramLayer {
  return {
    color: "#3b82f6",
    collapsed: false,
    visible: true,
    layoutMode: "auto",
    position: { x: 0, y: 0 },
    width: 240,
    height: 100,
    ...partial,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

test("isTableCanvasVisible: unlayered always visible; hidden layer hides members", () => {
  const layers = [
    layer({ id: "l1", name: "Core", tableNames: ["users"], visible: false }),
    layer({ id: "l2", name: "Open", tableNames: ["orders"], visible: true }),
  ];
  assert.equal(isTableCanvasVisible("orphan", layers), true);
  assert.equal(isTableCanvasVisible("users", layers), false);
  assert.equal(isTableCanvasVisible("orders", layers), true);
});

test("toVueFlowNodes filters tables on hidden layers", () => {
  const store = useLayerStore();
  const hidden = store.addLayer("Hidden");
  const shown = store.addLayer("Shown");
  store.addTableToLayer(hidden.id, "users");
  store.addTableToLayer(shown.id, "orders");
  store.toggleLayerVisibility(hidden.id);

  const nodes = toVueFlowNodes([table("users"), table("orders"), table("orphan")], {
    users: { x: 10, y: 10 },
    orders: { x: 20, y: 20 },
    orphan: { x: 30, y: 30 },
  });
  assert.deepEqual(nodes.map((n) => n.id).sort(), ["orders", "orphan"]);
});

test("toVueFlowNodes hides tables marked pendingDrop", () => {
  const nodes = toVueFlowNodes(
    [
      { ...table("users"), pendingDrop: true },
      table("orders"),
    ],
    {
      users: { x: 10, y: 10 },
      orders: { x: 20, y: 20 },
    },
  );
  assert.deepEqual(nodes.map((n) => n.id), ["orders"]);
});

test("toVueFlowEdges filters when either endpoint layer is hidden", () => {
  const store = useLayerStore();
  const hidden = store.addLayer("Hidden");
  const shown = store.addLayer("Shown");
  store.addTableToLayer(hidden.id, "users");
  store.addTableToLayer(shown.id, "orders");
  store.addTableToLayer(shown.id, "items");
  store.toggleLayerVisibility(hidden.id);

  const relationships: DiagramRelationship[] = [
    {
      id: "e1",
      name: "fk1",
      kind: "foreign-key",
      sourceTable: "orders",
      sourceColumn: "user_id",
      targetTable: "users",
      targetColumn: "id",
      sourceCardinality: "N",
      targetCardinality: "1",
    },
    {
      id: "e2",
      name: "fk2",
      kind: "foreign-key",
      sourceTable: "items",
      sourceColumn: "order_id",
      targetTable: "orders",
      targetColumn: "id",
      sourceCardinality: "N",
      targetCardinality: "1",
    },
  ];

  const edges = toVueFlowEdges(relationships);
  assert.deepEqual(edges.map((e) => e.id), ["e2"]);
});
