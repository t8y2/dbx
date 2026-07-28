import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildSqlCompletionItems } from "../../apps/desktop/src/lib/sql/sqlCompletion.ts";

test("inserts PostgreSQL routine parameters and preserves overloaded functions", () => {
  const sql = "SELECT st_astext";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    columnsByTable: new Map(),
    objects: [
      { name: "st_astext", schema: "public", type: "function", signature: "geometry", dataType: "text" },
      { name: "st_astext", schema: "public", type: "function", signature: "geography, integer", dataType: "text" },
    ],
    databaseType: "postgres",
    currentSchema: "public",
  });

  const functions = items.filter((item) => item.label === "st_astext" && item.type === "function");
  assert.deepEqual(
    functions.map((item) => ({ apply: item.apply, detail: item.detail })),
    [
      { apply: "st_astext(${geometry})", detail: "function in public  (geometry)  [text]" },
      { apply: "st_astext(${geography}, ${integer})", detail: "function in public  (geography, integer)  [text]" },
    ],
  );
});

test("splits routine parameters only on top-level commas", () => {
  const sql = "SELECT transform_value";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    columnsByTable: new Map(),
    objects: [{ name: "transform_value", schema: "public", type: "function", signature: 'numeric(10, 2), "custom,schema"."value,type"[], text[]' }],
    databaseType: "postgres",
    currentSchema: "public",
  });

  assert.equal(items.find((item) => item.label === "transform_value")?.apply, 'transform_value(${numeric(10, 2)}, ${"custom,schema"."value,type"[]}, ${text[]})');
});

test("keeps empty and unavailable routine signatures as empty parentheses", () => {
  const sql = "SELECT current_marker";
  const baseInput = { tables: [], columnsByTable: new Map(), databaseType: "postgres" as const, currentSchema: "public" };

  assert.equal(buildSqlCompletionItems(sql, sql.length, { ...baseInput, objects: [{ name: "current_marker", schema: "public", type: "function", signature: "" }] }).find((item) => item.label === "current_marker")?.apply, "current_marker()");
  assert.equal(buildSqlCompletionItems(sql, sql.length, { ...baseInput, objects: [{ name: "current_marker", schema: "public", type: "function" }] }).find((item) => item.label === "current_marker")?.apply, "current_marker()");
});
