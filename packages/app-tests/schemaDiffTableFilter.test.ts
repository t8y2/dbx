import assert from "node:assert/strict";
import { test } from "vitest";
import { compileSchemaDiffTableFilter, filterSchemaDiffTables } from "../../apps/desktop/src/lib/schemaDiffTableFilter.ts";
import type { TableInfo } from "../../apps/desktop/src/types/database.ts";
import { normalizeSchemaDiffCompareOptions } from "../../apps/desktop/src/types/schemaDiff.ts";

function table(name: string): TableInfo {
  return {
    name,
    table_type: "BASE TABLE",
    comment: null,
    parent_schema: null,
    parent_name: null,
  };
}

test("filters schema diff tables before detail loading", () => {
  const filter = compileSchemaDiffTableFilter(
    normalizeSchemaDiffCompareOptions({
      tableIncludePattern: "^user_|^orders$",
      tableExcludePattern: "_bak$",
      tableFilterPriority: "exclude",
    }),
  );

  const result = filterSchemaDiffTables([table("user_profile"), table("user_profile_bak"), table("orders"), table("audit_log")], [table("user_profile"), table("orders_bak"), table("orders")], filter);

  assert.deepEqual(
    result.sourceTables.map((item) => item.name),
    ["user_profile", "orders"],
  );
  assert.deepEqual(
    result.targetTables.map((item) => item.name),
    ["user_profile", "orders"],
  );
});

test("lets include priority keep tables that also match exclude", () => {
  const filter = compileSchemaDiffTableFilter(
    normalizeSchemaDiffCompareOptions({
      tableIncludePattern: "^user_",
      tableExcludePattern: "_bak$",
      tableFilterPriority: "include",
    }),
  );

  const result = filterSchemaDiffTables([table("user_profile_bak")], [], filter);

  assert.deepEqual(
    result.sourceTables.map((item) => item.name),
    ["user_profile_bak"],
  );
});

test("rejects invalid schema diff table regex", () => {
  assert.throws(
    () =>
      compileSchemaDiffTableFilter(
        normalizeSchemaDiffCompareOptions({
          tableIncludePattern: "[",
        }),
      ),
    /Invalid include table name regex/,
  );
});
