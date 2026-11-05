// Regression tests for upstream issue t8y2/dbx#11956:
// 「对查询表数据进行搜索时，数据存在但搜索不到」
// The result-grid Ctrl+F search runs over the FORMATTED DISPLAY text of each
// cell, which DataGrid.vue truncates with limitDataGridCellDisplay at
// DATA_GRID_CELL_DISPLAY_MAX_LENGTH (256) characters. A search term past that
// cut was invisible to Ctrl+F while a server-side WHERE found it.
//
// Fix: the match scan re-checks the full raw value of cells whose display text
// is truncated (ends with "..."), so matches past the display cut are found.
//
// The wiring below mirrors DataGrid.vue's useDataGridSearch call for a plain
// text column (DataGrid.vue:1146-1170): search text = lowercase of the
// 256-char-truncated display value.
import { nextTick } from "vue";
import { test, vi } from "vitest";
import { strict as assert } from "node:assert";
import { useDataGridSearch } from "../../apps/desktop/src/composables/useDataGridSearch.ts";
import { limitDataGridCellDisplay } from "../../apps/desktop/src/lib/dataGrid/cellValue.ts";

async function flushSearchDebounce() {
  await nextTick();
  vi.runOnlyPendingTimers();
  await nextTick();
  await nextTick();
}

// Same shape as DataGrid.vue's getCellSearchText for a plain text column.
const cellSearchText = (row: string[], column: number): string => limitDataGridCellDisplay(String(row[column] ?? "")).toLowerCase();

function longValue(prefix: string, needle: string, totalLength: number): string {
  const head = `${prefix}${"x".repeat(totalLength)}`.slice(0, totalLength);
  // Place the needle just past the 256-character display cut.
  return head.slice(0, 260) + needle + head.slice(260 + needle.length);
}

test("finds values whose match sits past the 256-char display cut", async () => {
  vi.useFakeTimers();

  const rows = [
    [longValue("row A: ", "needle_a", 400)],
    [longValue("row B: ", "needle_b", 400)],
    [longValue("row C: ", "needle_c", 400)],
    // Control: same row shape but the keyword within the first 256 chars.
    [longValue("row D: ", "needle_d", 100)],
  ];
  const search = useDataGridSearch({
    columns: ["content"],
    rows,
    getCellSearchText: cellSearchText,
    getCellRawSearchText: (row, col) => String(row[col] ?? ""),
    includeColumnMatches: false,
  });

  for (const needle of ["needle_a", "needle_b", "needle_c", "needle_d"]) {
    search.searchText.value = needle;
    await flushSearchDebounce();
    assert.equal(search.matchCount.value, 1, `Ctrl+F "${needle}" should match its row; the data exists and WHERE finds it`);
  }
});

test("does not report truncated cells whose raw value has no match", async () => {
  vi.useFakeTimers();

  // A raw value that legitimately ends with "..." but never contains the query
  // must not become a false positive through the raw re-check.
  const rows = [["x".repeat(300) + "..."]];
  const search = useDataGridSearch({
    columns: ["content"],
    rows,
    getCellSearchText: cellSearchText,
    getCellRawSearchText: (row, col) => String(row[col] ?? ""),
    includeColumnMatches: false,
  });
  search.searchText.value = "needle_none";
  await flushSearchDebounce();
  assert.equal(search.matchCount.value, 0);
});
