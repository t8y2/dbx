import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { filterObjectBrowserTableColumns } from "../../apps/desktop/src/lib/table/objectBrowserTableInfo.ts";

const columns = [
  { name: "business_id", data_type: "varchar(64)", comment: "业务ID" },
  { name: "created_at", data_type: "TIMESTAMP", comment: "Created time" },
  { name: "status", data_type: "INT", comment: null },
  { name: "note", data_type: "TEXT" },
  { name: "empty_note", data_type: "TEXT", comment: "" },
];

test("filters table-info columns by case-insensitive name and trimmed type text", () => {
  assert.deepEqual(
    filterObjectBrowserTableColumns(columns, "BUSINESS").map((column) => column.name),
    ["business_id"],
  );
  assert.deepEqual(
    filterObjectBrowserTableColumns(columns, "  timestamp  ").map((column) => column.name),
    ["created_at"],
  );
});

test("filters table-info columns by partial localized and case-insensitive comments", () => {
  assert.deepEqual(
    filterObjectBrowserTableColumns(columns, "业务").map((column) => column.name),
    ["business_id"],
  );
  assert.deepEqual(
    filterObjectBrowserTableColumns(columns, "CREATED TIME").map((column) => column.name),
    ["created_at"],
  );
});

test("handles missing, null, and empty comments without changing no-match behavior", () => {
  assert.deepEqual(filterObjectBrowserTableColumns(columns, "not present"), []);
});

test("returns every column for empty searches and preserves match order", () => {
  assert.deepEqual(
    filterObjectBrowserTableColumns(columns, "   ").map((column) => column.name),
    columns.map((column) => column.name),
  );
  assert.deepEqual(
    filterObjectBrowserTableColumns(columns, "text").map((column) => column.name),
    ["note", "empty_note"],
  );
});

test("keeps the data-grid table properties search on the shared column filter", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");

  assert.match(source, /filterObjectBrowserTableColumns\(props\.tableMeta\?\.columns \?\? \[\], searchQuery\.value\)/);
});
