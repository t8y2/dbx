import assert from "node:assert/strict";
import { test } from "vitest";
import { compileSchemaDiffTableFilter, filterSchemaDiffTables } from "../../apps/desktop/src/lib/schema/schemaDiffTableFilter.ts";
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

test("respects explicit visual table selection before loading details", () => {
  const filter = compileSchemaDiffTableFilter(normalizeSchemaDiffCompareOptions({}));

  const tables = [table("a"), table("b"), table("c"), table("d")];
  const result = filterSchemaDiffTables(tables, tables, filter, undefined, ["a", "c"]);

  assert.deepEqual(
    result.sourceTables.map((item) => item.name),
    ["a", "c"],
  );
});

test("intersects visual selection with the include regex", () => {
  const filter = compileSchemaDiffTableFilter(
    normalizeSchemaDiffCompareOptions({
      tableIncludePattern: "^user_",
    }),
  );

  const tables = [table("user_a"), table("user_b"), table("order")];
  const result = filterSchemaDiffTables(tables, tables, filter, undefined, ["user_a", "user_b", "order"]);

  assert.deepEqual(
    result.sourceTables.map((item) => item.name),
    ["user_a", "user_b"],
  );
});

test("intersects visual selection with the exclude regex", () => {
  const filter = compileSchemaDiffTableFilter(
    normalizeSchemaDiffCompareOptions({
      tableExcludePattern: "_backup$",
    }),
  );

  const tables = [table("user"), table("user_backup")];
  const result = filterSchemaDiffTables(tables, tables, filter, undefined, ["user", "user_backup"]);

  assert.deepEqual(
    result.sourceTables.map((item) => item.name),
    ["user"],
  );
});

test("undefined visual selection keeps legacy all-tables behavior", () => {
  const filter = compileSchemaDiffTableFilter(
    normalizeSchemaDiffCompareOptions({
      tableIncludePattern: "^user_",
    }),
  );
  const tables = [table("user_a"), table("user_b"), table("order")];
  const result = filterSchemaDiffTables(tables, tables, filter, undefined, undefined);

  assert.deepEqual(
    result.sourceTables.map((item) => item.name),
    ["user_a", "user_b"],
  );
});

test("explicit empty selection remains restricted after option normalization", () => {
  const options = normalizeSchemaDiffCompareOptions({ selectedTables: [] });
  assert.deepEqual(options.selectedTables, []);
  const filter = compileSchemaDiffTableFilter(options);
  const result = filterSchemaDiffTables([table("a")], [table("a")], filter, undefined, options.selectedTables);
  assert.deepEqual(result.sourceTables, []);
  assert.deepEqual(result.targetTables, []);
});

test("selected source tables remain available for create diffs when the target is missing", () => {
  const options = normalizeSchemaDiffCompareOptions({});
  const filter = compileSchemaDiffTableFilter(options);
  const result = filterSchemaDiffTables([table("a"), table("b")], [table("a"), table("extra")], filter, undefined, ["a", "b"]);
  assert.deepEqual(result.sourceTables.map((item) => item.name), ["a", "b"]);
  assert.deepEqual(result.targetTables.map((item) => item.name), ["a"]);
});
