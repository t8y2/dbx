import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  filterAssignableDiagramTables,
  hasDroppedColumns,
  hasPendingColumns,
  isDiagramTableAssignable,
  isDraftTable,
  isDroppedColumn,
  isLiveTable,
  isPendingColumn,
  needsDiagramSync,
  type DiagramTable,
} from "../../apps/desktop/src/lib/diagram/erDiagram.ts";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";

function col(name: string): ColumnInfo {
  return {
    name,
    data_type: "varchar(255)",
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
  };
}

function table(partial: Partial<DiagramTable> & { name: string }): DiagramTable {
  return {
    columns: [],
    foreignKeys: [],
    ...partial,
  };
}

test("isDraftTable / isLiveTable treat missing origin as live", () => {
  const draft = table({ name: "d", origin: "draft" });
  const live = table({ name: "l", origin: "live" });
  const legacy = table({ name: "x" });

  assert.equal(isDraftTable(draft), true);
  assert.equal(isLiveTable(draft), false);
  assert.equal(isDraftTable(live), false);
  assert.equal(isLiveTable(live), true);
  assert.equal(isDraftTable(legacy), false);
  assert.equal(isLiveTable(legacy), true);
});

test("hasPendingColumns / isPendingColumn", () => {
  const withPending = table({
    name: "users",
    origin: "live",
    columns: [col("id"), col("nickname")],
    pendingColumnNames: ["nickname"],
  });
  assert.equal(hasPendingColumns(withPending), true);
  assert.equal(isPendingColumn(withPending, "nickname"), true);
  assert.equal(isPendingColumn(withPending, "id"), false);

  const empty = table({ name: "users", origin: "live", pendingColumnNames: [] });
  assert.equal(hasPendingColumns(empty), false);
  assert.equal(hasPendingColumns(table({ name: "users" })), false);
});

test("needsDiagramSync for draft and live pending", () => {
  assert.equal(needsDiagramSync(table({ name: "d", origin: "draft" })), true);
  assert.equal(
    needsDiagramSync(table({ name: "l", origin: "live", pendingColumnNames: ["x"], columns: [col("x")] })),
    true,
  );
  assert.equal(needsDiagramSync(table({ name: "l", origin: "live" })), false);
  assert.equal(needsDiagramSync(table({ name: "legacy" })), false);
});

test("hasDroppedColumns / isDroppedColumn / needsDiagramSync for drops", () => {
  const withDrop = table({
    name: "users",
    origin: "live",
    columns: [col("id"), col("nickname")],
    droppedColumnNames: ["nickname"],
  });
  assert.equal(hasDroppedColumns(withDrop), true);
  assert.equal(isDroppedColumn(withDrop, "nickname"), true);
  assert.equal(isDroppedColumn(withDrop, "id"), false);
  assert.equal(needsDiagramSync(withDrop), true);

  const pendingDrop = table({ name: "orders", origin: "live", pendingDrop: true });
  assert.equal(needsDiagramSync(pendingDrop), true);
});

test("filterAssignableDiagramTables excludes pendingDrop tables", () => {
  const live = table({ name: "users", origin: "live" });
  const pendingDrop = table({ name: "orders", origin: "live", pendingDrop: true });
  const draft = table({ name: "draft_t", origin: "draft" });

  assert.equal(isDiagramTableAssignable(live), true);
  assert.equal(isDiagramTableAssignable(pendingDrop), false);
  assert.equal(isDiagramTableAssignable(draft), true);
  assert.deepEqual(
    filterAssignableDiagramTables([live, pendingDrop, draft]).map((t) => t.name),
    ["users", "draft_t"],
  );
});
