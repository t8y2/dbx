import { strict as assert } from "node:assert";
import { beforeEach, test } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useLayerStore } from "../../apps/desktop/src/lib/diagram/layer-store.ts";
import { findLayerAtPoint, placeNewLayer, sizeLayerToFit } from "../../apps/desktop/src/lib/diagram/size-layer.ts";
import { CARD_WIDTH, EMPTY_LAYER_HEIGHT, EMPTY_LAYER_WIDTH, LAYER_CONTENT_PADDING, LAYER_HEADER_HEIGHT, MARGIN } from "../../apps/desktop/src/lib/diagram/diagram-constants.ts";
import type { DiagramLayer } from "../../apps/desktop/src/types/diagram.ts";
import { LAYER_COLORS } from "../../apps/desktop/src/types/diagram.ts";

beforeEach(() => {
  setActivePinia(createPinia());
});

test("addLayer defaults visible, auto layout, Layer N name, and unique colors", () => {
  const store = useLayerStore();
  const a = store.addLayer();
  const b = store.addLayer();

  assert.equal(a.visible, true);
  assert.equal(a.layoutMode, "auto");
  assert.equal(a.name, "Layer 1");
  assert.equal(b.name, "Layer 2");
  assert.notEqual(a.color, b.color);
  assert.ok(LAYER_COLORS.includes(a.color));
  assert.equal(store.activeLayerId, b.id);
});

test("addLayer collapses all existing layers", () => {
  const store = useLayerStore();
  const a = store.addLayer("A");
  assert.equal(a.collapsed, false);
  const b = store.addLayer("B");
  assert.equal(store.layers.find((l) => l.id === a.id)?.collapsed, true);
  assert.equal(b.collapsed, false);
  store.addLayer("C");
  assert.equal(store.layers.find((l) => l.id === a.id)?.collapsed, true);
  assert.equal(store.layers.find((l) => l.id === b.id)?.collapsed, true);
});

test("moveTableToLayer enforces single-layer membership", () => {
  const store = useLayerStore();
  const layerA = store.addLayer("A");
  const layerB = store.addLayer("B");
  store.addTableToLayer(layerA.id, "users");
  store.moveTableToLayer("users", layerB.id);

  assert.deepEqual(store.getLayerByTable("users")?.id, layerB.id);
  assert.ok(!layerA.tableNames.includes("users"));
  assert.ok(layerB.tableNames.includes("users"));
});

test("removeTableFromLayer, setLayoutMode, geometry, and visibility toggle", () => {
  const store = useLayerStore();
  const layer = store.addLayer("Core", { x: 10, y: 20 }, { width: 300, height: 100 });
  store.addTableToLayer(layer.id, "orders");
  store.setLayoutMode(layer.id, "free");
  store.updateLayerGeometry(layer.id, { position: { x: 50, y: 60 }, width: 400, height: 200 });
  store.toggleLayerVisibility(layer.id);
  store.removeTableFromLayer(layer.id, "orders");

  const current = store.layers.find((l) => l.id === layer.id)!;
  assert.equal(current.layoutMode, "free");
  assert.deepEqual(current.position, { x: 50, y: 60 });
  assert.equal(current.width, 400);
  assert.equal(current.height, 200);
  assert.equal(current.visible, false);
  assert.deepEqual(current.tableNames, []);
});

test("sizeLayerToFit uses empty size or wraps table bbox with padding", () => {
  const empty: DiagramLayer = {
    id: "l0",
    name: "Empty",
    color: "#3b82f6",
    tableNames: [],
    collapsed: false,
    visible: true,
    layoutMode: "auto",
    position: { x: 0, y: 0 },
    width: 1,
    height: 1,
  };
  sizeLayerToFit(empty, {}, {});
  assert.equal(empty.width, EMPTY_LAYER_WIDTH);
  assert.equal(empty.height, EMPTY_LAYER_HEIGHT);

  const filled: DiagramLayer = {
    ...empty,
    id: "l1",
    tableNames: ["users", "orders"],
  };
  sizeLayerToFit(
    filled,
    { users: { x: 100, y: 100 }, orders: { x: 200, y: 180 } },
    { users: 120, orders: 140 },
  );
  assert.equal(filled.position?.x, 100 - LAYER_CONTENT_PADDING);
  assert.equal(filled.position?.y, 100 - LAYER_HEADER_HEIGHT - LAYER_CONTENT_PADDING);
  assert.ok((filled.width ?? 0) >= CARD_WIDTH + LAYER_CONTENT_PADDING * 2);
  assert.ok((filled.height ?? 0) >= EMPTY_LAYER_HEIGHT);
});

test("findLayerAtPoint returns topmost hit and placeNewLayer avoids overlap", () => {
  const layers: DiagramLayer[] = [
    {
      id: "bottom",
      name: "Bottom",
      color: "#3b82f6",
      tableNames: [],
      collapsed: false,
      visible: true,
      layoutMode: "auto",
      position: { x: 0, y: 0 },
      width: 200,
      height: 100,
    },
    {
      id: "top",
      name: "Top",
      color: "#10b981",
      tableNames: [],
      collapsed: false,
      visible: true,
      layoutMode: "auto",
      position: { x: 50, y: 20 },
      width: 200,
      height: 100,
    },
  ];

  assert.equal(findLayerAtPoint({ x: 60, y: 30 }, layers)?.id, "top");
  assert.equal(findLayerAtPoint({ x: 10, y: 10 }, layers)?.id, "bottom");
  assert.equal(findLayerAtPoint({ x: 60, y: 30 }, layers, "top")?.id, "bottom");

  const placement = placeNewLayer(layers, {}, {});
  assert.equal(placement.width, EMPTY_LAYER_WIDTH);
  assert.equal(placement.height, EMPTY_LAYER_HEIGHT);
  assert.ok(placement.position.x >= MARGIN);
  assert.equal(
    findLayerAtPoint(
      { x: placement.position.x + 1, y: placement.position.y + 1 },
      [
        ...layers,
        {
          id: "new",
          name: "New",
          color: "#000",
          tableNames: [],
          collapsed: false,
          visible: true,
          layoutMode: "auto",
          position: placement.position,
          width: placement.width,
          height: placement.height,
        },
      ],
    )?.id,
    "new",
  );
});
