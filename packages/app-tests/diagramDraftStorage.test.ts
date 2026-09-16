import { strict as assert } from "node:assert";
import { beforeEach, test, vi } from "vitest";
import {
  hasUsablePersistedPositions,
  loadDraftTables,
  loadPersistedLayers,
  loadPersistedPositions,
  saveDraftTables,
  savePersistedLayers,
  savePersistedPositions,
} from "../../apps/desktop/src/lib/diagram/draft-storage.ts";
import { createDraftTable } from "../../apps/desktop/src/lib/diagram/draft-table.ts";
import type { DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";
import type { DiagramLayer } from "../../apps/desktop/src/types/diagram.ts";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
});

test("savePersistedPositions / loadPersistedPositions round-trip", () => {
  const positions = {
    users: { x: 10, y: 20 },
    roles: { x: 100.5, y: -3 },
  };
  savePersistedPositions(positions, "conn-1", "db", "public");
  const loaded = loadPersistedPositions("conn-1", "db", "public");
  assert.deepEqual(loaded, positions);
});

test("loadPersistedPositions drops invalid entries", () => {
  store.set(
    ["dbx", "diagram", "positions", "v1", "c", "d", "s"].join(":"),
    JSON.stringify({
      ok: { x: 1, y: 2 },
      bad: { x: "no", y: 2 },
      missingY: { x: 1 },
      nan: { x: Number.NaN, y: 0 },
    }),
  );
  const loaded = loadPersistedPositions("c", "d", "s");
  assert.deepEqual(loaded, { ok: { x: 1, y: 2 } });
});

test("hasUsablePersistedPositions requires at least one known table", () => {
  assert.equal(hasUsablePersistedPositions({ users: { x: 0, y: 0 } }, ["roles"]), false);
  assert.equal(hasUsablePersistedPositions({ users: { x: 0, y: 0 } }, ["users", "roles"]), true);
  assert.equal(hasUsablePersistedPositions({}, ["users"]), false);
});

test("saveDraftTables / loadDraftTables round-trip and only persists drafts", () => {
  const draft = createDraftTable("orders");
  const live: DiagramTable = {
    name: "users",
    columns: draft.columns,
    foreignKeys: [],
    origin: "live",
  };
  saveDraftTables([draft, live], "conn-1", "db", "public");
  const loaded = loadDraftTables("conn-1", "db", "public");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "orders");
  assert.equal(loaded[0].origin, "draft");
  assert.equal(loaded[0].syncStatus, "pending");
});

test("loadDraftTables drops invalid entries and normalizes origin/syncStatus", () => {
  store.set(
    ["dbx", "diagram", "draft-tables", "v1", "c", "d", "s"].join(":"),
    JSON.stringify([
      { name: "ok", columns: [], foreignKeys: [], syncStatus: "error" },
      { name: 123, columns: [] },
      { name: "no-cols" },
      null,
    ]),
  );
  const loaded = loadDraftTables("c", "d", "s");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "ok");
  assert.equal(loaded[0].origin, "draft");
  assert.equal(loaded[0].syncStatus, "error");
});

test("savePersistedLayers / loadPersistedLayers round-trip", () => {
  const layers: DiagramLayer[] = [
    {
      id: "l1",
      name: "Core",
      color: "#3b82f6",
      tableNames: ["users"],
      collapsed: false,
      visible: true,
      layoutMode: "auto",
      position: { x: 10, y: 20 },
      width: 240,
      height: 100,
    },
  ];
  savePersistedLayers(layers, "conn-1", "db", "public");
  assert.deepEqual(loadPersistedLayers("conn-1", "db", "public"), layers);
});

test("empty connectionId or database skips write and load returns empty", () => {
  saveDraftTables([createDraftTable("t")], "", "db", "public");
  saveDraftTables([createDraftTable("t")], "c", "", "public");
  savePersistedLayers([], "", "db", "public");
  savePersistedPositions({ t: { x: 1, y: 2 } }, "c", "", "public");
  assert.equal(store.size, 0);
  assert.deepEqual(loadDraftTables("", "db", "public"), []);
  assert.deepEqual(loadPersistedLayers("c", "", "public"), []);
  assert.deepEqual(loadPersistedPositions("", "db", "public"), {});
});
