import { strict as assert } from "node:assert";
import { test } from "vitest";
import { resolveHistoryActivityKind } from "../../apps/desktop/src/lib/history/historyActivityKind.ts";

test("legacy INSERT history entries are treated as data changes", () => {
  assert.equal(
    resolveHistoryActivityKind({
      activity_kind: "query",
      operation: "INSERT",
      sql: "INSERT INTO job_entries (id) VALUES (1)",
    }),
    "data_change",
  );
});

test("legacy CREATE history entries are treated as schema changes", () => {
  assert.equal(
    resolveHistoryActivityKind({
      activity_kind: "query",
      operation: "CREATE",
      sql: "CREATE TABLE resume_contexts (id bigint)",
    }),
    "schema_change",
  );
});

test("SELECT history entries stay queries", () => {
  assert.equal(
    resolveHistoryActivityKind({
      activity_kind: "query",
      operation: "SELECT",
      sql: "SELECT * FROM education_notes",
    }),
    "query",
  );
});
