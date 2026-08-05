import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  computeLtrAutoLayout,
  orderTablesByConnectivity,
  reflowUnassignedTables,
} from "../../apps/desktop/src/lib/diagram/ltr-auto-layout.ts";
import { CARD_WIDTH } from "../../apps/desktop/src/lib/diagram/diagram-constants.ts";
import type { DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";
import type { DiagramLayer } from "../../apps/desktop/src/types/diagram.ts";

function table(name: string, columns = 2): DiagramTable {
  return {
    name,
    columns: Array.from({ length: columns }, (_, i) => ({
      name: i === 0 ? "id" : `c${i}`,
      data_type: "bigint",
      is_nullable: false,
      column_default: null,
      is_primary_key: i === 0,
      extra: null,
    })),
    foreignKeys: [],
  };
}

test("orderTablesByConnectivity keeps connected tables adjacent", () => {
  const tables = [table("zeta"), table("users"), table("orders"), table("alpha")];
  const ordered = orderTablesByConnectivity(tables, [
    { sourceTable: "orders", targetTable: "users" },
  ]);
  const names = ordered.map((t) => t.name);
  const usersIdx = names.indexOf("users");
  const ordersIdx = names.indexOf("orders");
  assert.equal(Math.abs(usersIdx - ordersIdx), 1);
  assert.ok(names.includes("alpha"));
  assert.ok(names.includes("zeta"));
});

test("computeLtrAutoLayout places tables without overlap and respects CARD_WIDTH", () => {
  const tables = [table("a"), table("b"), table("c")];
  const { positions } = computeLtrAutoLayout({
    tables,
    positions: {},
    layers: [],
    paneWidth: 1200,
    relationships: [{ sourceTable: "b", targetTable: "a" }],
  });

  const names = Object.keys(positions);
  assert.equal(names.length, 3);
  for (const name of names) {
    assert.ok(Number.isFinite(positions[name].x));
    assert.ok(Number.isFinite(positions[name].y));
  }

  // Axis-aligned cards using CARD_WIDTH should not overlap
  const boxes = names.map((name) => ({
    name,
    x: positions[name].x,
    y: positions[name].y,
    w: CARD_WIDTH,
    h: 100,
  }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
      assert.equal(overlap, false, `${a.name} overlaps ${b.name}`);
    }
  }
});

test("reflowUnassignedTables preserves positions of layered tables", () => {
  const layers: DiagramLayer[] = [
    {
      id: "l1",
      name: "Core",
      color: "#3b82f6",
      tableNames: ["users"],
      collapsed: false,
      visible: true,
      layoutMode: "auto",
      position: { x: 40, y: 40 },
      width: 400,
      height: 200,
    },
  ];
  const prev = {
    users: { x: 99, y: 88 },
    orders: { x: 500, y: 500 },
    payments: { x: 800, y: 600 },
  };
  const next = reflowUnassignedTables({
    tables: [table("users"), table("orders"), table("payments")],
    positions: prev,
    layers,
    paneWidth: 1200,
  });

  assert.deepEqual(next.users, prev.users);
  assert.notDeepEqual(next.orders, prev.orders);
  assert.ok(Number.isFinite(next.payments.x));
});

test("computeLtrAutoLayout keeps layer-assigned tables inside updated layer geometry", () => {
  const layers: DiagramLayer[] = [
    {
      id: "l1",
      name: "Core",
      color: "#3b82f6",
      tableNames: ["users", "orders"],
      collapsed: false,
      visible: true,
      layoutMode: "auto",
      position: { x: 0, y: 0 },
      width: 100,
      height: 80,
    },
  ];
  const { positions, layers: nextLayers } = computeLtrAutoLayout({
    tables: [table("users"), table("orders"), table("orphan")],
    positions: {
      users: { x: 0, y: 0 },
      orders: { x: 0, y: 0 },
      orphan: { x: 0, y: 0 },
    },
    layers,
    paneWidth: 1400,
    relationships: [{ sourceTable: "orders", targetTable: "users" }],
  });

  assert.equal(nextLayers.length, 1);
  const layer = nextLayers[0];
  assert.ok((layer.width ?? 0) > 100);
  assert.ok(positions.users.x >= (layer.position?.x ?? 0));
  assert.ok(positions.orders.x >= (layer.position?.x ?? 0));
  assert.ok(positions.orphan.y > (layer.position?.y ?? 0) + (layer.height ?? 0) - 1);
});
