import { strict as assert } from "node:assert";
import { test } from "vitest";
import { defaultViewForResult } from "../../apps/desktop/src/lib/query/queryResultDefaultView.ts";
import type { QueryMessage } from "../../apps/desktop/src/types/database.ts";

const notice: QueryMessage = { severity: "NOTICE", message: "hello", code: "00000" };

test("message-only results default to the messages view", () => {
  // e.g. PostgreSQL `DO $$ BEGIN RAISE NOTICE 'hello'; END $$;`
  const view = defaultViewForResult({ columns: [], rows: [], affected_rows: 0, messages: [notice] });

  assert.equal(view, "messages");
});

test("results without messages default to the summary view", () => {
  assert.equal(defaultViewForResult({ columns: [], rows: [], affected_rows: 0, messages: [] }), "summary");
  assert.equal(defaultViewForResult({ columns: [], rows: [], affected_rows: 0 }), "summary");
});

test("DML with affected rows keeps the summary view even with INFO messages", () => {
  // e.g. a MySQL INSERT whose OK packet carries "Records: 2  Duplicates: 0  Warnings: 0"
  const view = defaultViewForResult({
    columns: [],
    rows: [],
    affected_rows: 2,
    messages: [{ severity: "Note", message: "Records: 2  Duplicates: 0  Warnings: 0" }],
  });

  assert.equal(view, "summary");
});

test("tabular results keep the summary view even with messages", () => {
  const view = defaultViewForResult({ columns: ["value"], rows: [[1]], affected_rows: 0, messages: [notice] });

  assert.equal(view, "summary");
});

test("rows alone (without column metadata) keep the summary view", () => {
  const view = defaultViewForResult({ columns: [], rows: [["x"]], affected_rows: 0, messages: [notice] });

  assert.equal(view, "summary");
});
