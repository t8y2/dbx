import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { resolveDataGridColumnsByResultIndex } from "../../apps/desktop/src/lib/dataGrid/dataGridColumnMetadata.ts";
import { resolveDataGridNewRowCellPlaceholder } from "../../apps/desktop/src/lib/dataGrid/dataGridDefaultPlaceholder.ts";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";

function column(name: string, columnDefault: string | null): ColumnInfo {
  return {
    name,
    data_type: "text",
    is_nullable: true,
    column_default: columnDefault,
    is_primary_key: false,
    extra: null,
  };
}

test("explicitly unmapped result columns do not fall back to matching aliases", () => {
  const [resolved] = resolveDataGridColumnsByResultIndex({
    resultColumns: ["created_at"],
    sourceColumns: [undefined],
    tableColumns: [column("created_at", "CURRENT_TIMESTAMP")],
  });

  assert.equal(resolved, undefined);
});

test("new and draft null cells preserve usable raw column defaults", () => {
  const rawDefault = "  CURRENT_TIMESTAMP  ";
  const mappedColumn = column("created_at", rawDefault);

  assert.equal(resolveDataGridNewRowCellPlaceholder({ row: { data: [null], isNew: true }, columnIndex: 0, column: mappedColumn, draftFallback: "New" }), rawDefault);
  assert.equal(resolveDataGridNewRowCellPlaceholder({ row: { data: [null], isNew: false, isDraft: true }, columnIndex: 0, column: mappedColumn, draftFallback: "New" }), rawDefault);
});

test("unusable defaults keep the existing new and draft fallbacks", () => {
  for (const columnDefault of [null, "", "   ", "NULL", " nUlL "]) {
    const mappedColumn = column("created_at", columnDefault);
    assert.equal(resolveDataGridNewRowCellPlaceholder({ row: { data: [null], isNew: true }, columnIndex: 0, column: mappedColumn, draftFallback: "New" }), null);
    assert.equal(resolveDataGridNewRowCellPlaceholder({ row: { data: [null], isNew: false, isDraft: true }, columnIndex: 0, column: mappedColumn, draftFallback: "New" }), "New");
  }
});

test("existing nulls, explicit values, and unmapped new columns do not show schema defaults", () => {
  const mappedColumn = column("created_at", "CURRENT_TIMESTAMP");

  assert.equal(resolveDataGridNewRowCellPlaceholder({ row: { data: [null], isNew: false }, columnIndex: 0, column: mappedColumn, draftFallback: "New" }), null);
  assert.equal(resolveDataGridNewRowCellPlaceholder({ row: { data: ["manual"], isNew: true }, columnIndex: 0, column: mappedColumn, draftFallback: "New" }), null);
  assert.equal(resolveDataGridNewRowCellPlaceholder({ row: { data: [null], isNew: true }, columnIndex: 0, column: undefined, draftFallback: "New" }), null);
  assert.equal(resolveDataGridNewRowCellPlaceholder({ row: { data: [null], isNew: false, isDraft: true }, columnIndex: 0, column: undefined, draftFallback: "New" }), "New");
});

test("DOM and canvas paths consume the same per-cell placeholder resolver", () => {
  const dataGridSource = readFileSync(new URL("../../apps/desktop/src/components/grid/DataGrid.vue", import.meta.url), "utf8");
  const canvasSource = readFileSync(new URL("../../apps/desktop/src/lib/dataGrid/canvasDataGridRenderer.ts", import.meta.url), "utf8");

  assert.match(dataGridSource, /function newRowCellPlaceholder\(item: RowItem \| undefined, columnIndex: number\)/);
  assert.match(dataGridSource, /newRowCellPlaceholder,\n\s+isRowActive/);
  assert.match(dataGridSource, /newRowCellPlaceholder\(displayItems\[cell\.recordIndex\], cell\.valueIndex\)/);
  assert.match(dataGridSource, /newRowCellPlaceholder\(item, col\.actualColIdx\)/);
  assert.match(canvasSource, /newRowCellPlaceholder\?: \(row: CanvasDataGridRow, columnIndex: number\) => string \| null/);
  assert.match(canvasSource, /newRowCellPlaceholder\?\.\(item, actualColIdx\)/);
});
