import { strict as assert } from "node:assert";
import { beforeEach, test } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useGraphStore } from "../../apps/desktop/src/lib/diagram/graph-store.ts";
import type { HistorySnapshot } from "../../apps/desktop/src/types/diagram.ts";
import type { DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";

function emptyTable(name: string): DiagramTable {
  return { name, columns: [], foreignKeys: [] };
}

function snapshot(partial: Partial<HistorySnapshot> = {}): HistorySnapshot {
  return {
    nodes: [
      {
        id: "users",
        type: "table",
        position: { x: 10, y: 20 },
        data: { table: emptyTable("users") },
      },
    ],
    edges: [],
    positions: { users: { x: 10, y: 20 } },
    layers: [
      {
        id: "l1",
        name: "Core",
        color: "#3b82f6",
        tableNames: ["users"],
        collapsed: false,
        visible: true,
        layoutMode: "auto",
        position: { x: 0, y: 0 },
        width: 200,
        height: 100,
      },
    ],
    tables: [emptyTable("users")],
    customRelationships: [
      {
        id: "custom-1",
        name: "c",
        sourceTable: "users",
        sourceColumn: "id",
        targetTable: "orders",
        targetColumn: "user_id",
        sourceCardinality: "1",
        targetCardinality: "N",
      },
    ],
    edgeWaypoints: { "e-1": [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
    edgeHandleHints: { "e-1": { sourceHandle: "right", targetHandle: "left-target" } },
    matchConfirms: ["rel-a"],
    matchIgnores: ["rel-b"],
    ...partial,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

test("pushHistory enables undo and clears redo", () => {
  const store = useGraphStore();
  assert.equal(store.canUndo, false);
  store.pushHistory(snapshot());
  assert.equal(store.canUndo, true);

  const current = snapshot({ positions: { users: { x: 99, y: 99 } } });
  const undone = store.undo(current);
  assert.ok(undone);
  assert.deepEqual(undone!.positions.users, { x: 10, y: 20 });
  assert.equal(store.canRedo, true);

  store.pushHistory(snapshot({ positions: { users: { x: 1, y: 1 } } }));
  assert.equal(store.canRedo, false);
});

test("undo/redo round-trips snapshot extras", () => {
  const store = useGraphStore();
  const older = snapshot({
    positions: { users: { x: 1, y: 1 } },
    matchConfirms: ["old"],
  });
  const newer = snapshot({
    positions: { users: { x: 2, y: 2 } },
    matchConfirms: ["new"],
    layers: [],
  });

  store.pushHistory(older);
  const afterUndo = store.undo(newer);
  assert.ok(afterUndo);
  assert.deepEqual(afterUndo!.positions.users, { x: 1, y: 1 });
  assert.deepEqual(afterUndo!.layers[0]?.tableNames, ["users"]);
  assert.deepEqual(afterUndo!.edgeWaypoints["e-1"]?.length, 2);
  assert.deepEqual(afterUndo!.customRelationships[0]?.id, "custom-1");
  assert.deepEqual(afterUndo!.matchConfirms, ["old"]);
  assert.deepEqual(afterUndo!.matchIgnores, ["rel-b"]);
  assert.ok(afterUndo!.edgeHandleHints["e-1"]);

  const afterRedo = store.redo(afterUndo!);
  assert.ok(afterRedo);
  assert.deepEqual(afterRedo!.positions.users, { x: 2, y: 2 });
  assert.deepEqual(afterRedo!.matchConfirms, ["new"]);
  assert.deepEqual(afterRedo!.layers, []);
});

test("undo/redo round-trips tables field", () => {
  const store = useGraphStore();
  const olderTables = [emptyTable("users"), emptyTable("draft_a")];
  const newerTables = [emptyTable("users"), emptyTable("draft_b")];
  const older = snapshot({ tables: olderTables, positions: { users: { x: 1, y: 1 } } });
  const newer = snapshot({ tables: newerTables, positions: { users: { x: 2, y: 2 } } });

  store.pushHistory(older);
  const afterUndo = store.undo(newer);
  assert.ok(afterUndo);
  assert.deepEqual(
    afterUndo!.tables.map((t) => t.name),
    ["users", "draft_a"],
  );

  const afterRedo = store.redo(afterUndo!);
  assert.ok(afterRedo);
  assert.deepEqual(
    afterRedo!.tables.map((t) => t.name),
    ["users", "draft_b"],
  );
});
