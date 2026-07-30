import { strict as assert } from "node:assert";
import { snippetCompletion } from "@codemirror/autocomplete";
import { EditorState, type Transaction } from "@codemirror/state";
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
      { apply: "st_astext(${1:geometry})", detail: "function in public  (geometry)  [text]" },
      { apply: "st_astext(${1:geography}, ${2:integer})", detail: "function in public  (geography, integer)  [text]" },
    ],
  );
});

test("keeps repeated routine parameter types as independent snippet fields", () => {
  const sql = "SELECT add_pair";
  const item = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    columnsByTable: new Map(),
    objects: [{ name: "add_pair", schema: "public", type: "function", signature: "integer, integer", dataType: "integer" }],
    databaseType: "postgres",
    currentSchema: "public",
  }).find((candidate) => candidate.label === "add_pair");

  assert.equal(item?.apply, "add_pair(${1:integer}, ${2:integer})");
  assert.equal(item?.detail, "function in public  (integer, integer)  [integer]");

  let state = EditorState.create({
    doc: sql,
    selection: { anchor: sql.length },
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
  const editor = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      state = transaction.state;
    },
  };
  const completion = snippetCompletion(item?.apply ?? "", { label: item?.label ?? "" });

  assert.equal(typeof completion.apply, "function");
  if (typeof completion.apply !== "function") return;
  completion.apply(editor as never, completion, "SELECT ".length, sql.length);
  editor.dispatch(state.update(state.replaceSelection("first_value")));

  assert.equal(state.doc.toString(), "SELECT add_pair(first_value, integer)");
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

  assert.equal(items.find((item) => item.label === "transform_value")?.apply, 'transform_value(${1:numeric(10, 2)}, ${2:"custom,schema"."value,type"[]}, ${3:text[]})');
});

test("keeps empty and unavailable routine signatures as empty parentheses", () => {
  const sql = "SELECT current_marker";
  const baseInput = { tables: [], columnsByTable: new Map(), databaseType: "postgres" as const, currentSchema: "public" };

  assert.equal(buildSqlCompletionItems(sql, sql.length, { ...baseInput, objects: [{ name: "current_marker", schema: "public", type: "function", signature: "" }] }).find((item) => item.label === "current_marker")?.apply, "current_marker()");
  assert.equal(buildSqlCompletionItems(sql, sql.length, { ...baseInput, objects: [{ name: "current_marker", schema: "public", type: "function" }] }).find((item) => item.label === "current_marker")?.apply, "current_marker()");
});
