import { strict as assert } from "node:assert";
import { beforeEach, test, vi } from "vitest";
import {
  applyLiveTablePatches,
  loadLiveTablePatches,
  saveLiveTablePatches,
} from "../../apps/desktop/src/lib/diagram/draft-storage.ts";
import { liveTableToAlterSqlOptions, validateLivePendingColumns } from "../../apps/desktop/src/lib/diagram/draft-table.ts";
import type { DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";

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

function col(name: string, dataType = "varchar(255)"): ColumnInfo {
  return {
    name,
    data_type: dataType,
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
  };
}

function liveTable(name: string, columns: ColumnInfo[], pendingColumnNames?: string[]): DiagramTable {
  return {
    name,
    columns,
    foreignKeys: [],
    origin: "live",
    pendingColumnNames,
  };
}

test("save/load live patches round-trip", () => {
  const tables = [
    liveTable("users", [col("id", "bigint"), col("nickname")], ["nickname"]),
  ];
  saveLiveTablePatches(tables, "c1", "db", "public");
  const loaded = loadLiveTablePatches("c1", "db", "public");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].tableName, "users");
  assert.equal(loaded[0].pendingColumns.length, 1);
  assert.equal(loaded[0].pendingColumns[0].name, "nickname");
});

test("applyLiveTablePatches merges missing pending columns", () => {
  const tables = [liveTable("users", [col("id", "bigint")])];
  const merged = applyLiveTablePatches(tables, [
    { tableName: "users", pendingColumns: [col("nickname")] },
  ]);
  assert.equal(merged[0].columns.length, 2);
  assert.deepEqual(merged[0].pendingColumnNames, ["nickname"]);
});

test("applyLiveTablePatches skips columns already in DB", () => {
  const tables = [liveTable("users", [col("id", "bigint"), col("nickname")])];
  const merged = applyLiveTablePatches(tables, [
    { tableName: "users", pendingColumns: [col("nickname")] },
  ]);
  assert.equal(merged[0].columns.length, 2);
  assert.equal(merged[0].pendingColumnNames, undefined);
});

test("liveTableToAlterSqlOptions marks only pending without original", () => {
  const table = liveTable("users", [col("id", "bigint"), col("nickname")], ["nickname"]);
  const options = liveTableToAlterSqlOptions(table, "postgres", "public");
  assert.ok(options.columns[0].original);
  assert.equal(options.columns[1].original, undefined);
});

test("validateLivePendingColumns catches empty type", () => {
  const table = liveTable("users", [col("id", "bigint"), { ...col("x"), data_type: "" }], ["x"]);
  const errors = validateLivePendingColumns(table);
  assert.ok(errors.some((e) => e.includes("needs a type")));
});

test("validateLivePendingColumns catches missing, duplicate, and conflict", () => {
  const missing = liveTable("users", [col("id")], ["ghost"]);
  assert.ok(validateLivePendingColumns(missing).some((e) => e.includes("is missing")));

  // Pending "name" collides with existing non-pending "Name" (case-insensitive).
  const conflict = liveTable("users", [col("id"), col("Name"), col("name")], ["name"]);
  assert.ok(validateLivePendingColumns(conflict).some((e) => e.includes("conflicts")));

  const duplicate = liveTable("users", [col("id"), col("nick")], ["nick", "nick"]);
  assert.ok(validateLivePendingColumns(duplicate).some((e) => e.includes("duplicate")));
});

test("saveLiveTablePatches ignores draft tables", () => {
  const draft: DiagramTable = {
    name: "draft_t",
    columns: [col("id")],
    foreignKeys: [],
    origin: "draft",
    pendingColumnNames: ["id"],
  };
  const live = liveTable("users", [col("id"), col("nickname")], ["nickname"]);
  saveLiveTablePatches([draft, live], "c1", "db", "public");
  const loaded = loadLiveTablePatches("c1", "db", "public");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].tableName, "users");
});

test("applyLiveTablePatches skips case-insensitive name collisions", () => {
  const tables = [liveTable("users", [col("ID", "bigint")])];
  const merged = applyLiveTablePatches(tables, [
    { tableName: "users", pendingColumns: [col("id", "bigint"), col("nickname")] },
  ]);
  assert.equal(merged[0].columns.length, 2);
  assert.deepEqual(merged[0].pendingColumnNames, ["nickname"]);
});

test("save/load persists dropped columns and pendingDrop", () => {
  const tables: DiagramTable[] = [
    {
      ...liveTable("users", [col("id"), col("nickname")]),
      droppedColumnNames: ["nickname"],
    },
    {
      ...liveTable("orders", [col("id")]),
      pendingDrop: true,
    },
  ];
  saveLiveTablePatches(tables, "c1", "db", "public");
  const loaded = loadLiveTablePatches("c1", "db", "public");
  assert.equal(loaded.length, 2);
  const users = loaded.find((p) => p.tableName === "users");
  const orders = loaded.find((p) => p.tableName === "orders");
  assert.deepEqual(users?.droppedColumnNames, ["nickname"]);
  assert.equal(orders?.pendingDrop, true);
});

test("applyLiveTablePatches restores dropped columns and pendingDrop", () => {
  const tables = [liveTable("users", [col("id"), col("nickname")]), liveTable("orders", [col("id")])];
  const merged = applyLiveTablePatches(tables, [
    { tableName: "users", pendingColumns: [], droppedColumnNames: ["nickname"] },
    { tableName: "orders", pendingColumns: [], pendingDrop: true },
  ]);
  assert.deepEqual(merged[0].droppedColumnNames, ["nickname"]);
  assert.equal(merged[1].pendingDrop, true);
});

test("liveTableToAlterSqlOptions marks dropped columns for drop", () => {
  const table: DiagramTable = {
    ...liveTable("users", [col("id", "bigint"), col("nickname")]),
    droppedColumnNames: ["nickname"],
  };
  const options = liveTableToAlterSqlOptions(table, "postgres", "public");
  assert.equal(options.columns[0].markedForDrop, false);
  assert.ok(options.columns[0].original);
  assert.equal(options.columns[1].markedForDrop, true);
  assert.ok(options.columns[1].original);
});

test("validateLivePendingColumns catches missing dropped column", () => {
  const table: DiagramTable = {
    ...liveTable("users", [col("id")]),
    droppedColumnNames: ["ghost"],
  };
  assert.ok(validateLivePendingColumns(table).some((e) => e.includes("dropped column") && e.includes("is missing")));
});
