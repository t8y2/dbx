import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildHistoryAiAnalysisPrompt, canRollbackHistoryEntry, type HistoryAiAnalysisEntry } from "../../apps/desktop/src/lib/historyAiAnalysis.ts";

const baseEntry: HistoryAiAnalysisEntry = {
  id: "h1",
  connection_name: "Local MySQL",
  database: "app",
  sql: "UPDATE users SET status = 'inactive' WHERE id = 42;",
  executed_at: "2026-05-15T07:30:00.000Z",
  execution_time_ms: 125,
  success: true,
  activity_kind: "data_change",
  operation: "UPDATE",
  target: "public.users",
  affected_rows: 1,
  rollback_sql: "UPDATE users SET status = 'active' WHERE id = 42;",
};

test("buildHistoryAiAnalysisPrompt includes operation details and rollback SQL", () => {
  const prompt = buildHistoryAiAnalysisPrompt(baseEntry);

  assert.match(prompt, /分析这条 DBX 历史记录/);
  assert.match(prompt, /Connection: Local MySQL/);
  assert.match(prompt, /Operation: UPDATE/);
  assert.match(prompt, /Affected rows: 1/);
  assert.match(prompt, /UPDATE users SET status = 'inactive'/);
  assert.match(prompt, /Rollback SQL/);
  assert.match(prompt, /UPDATE users SET status = 'active'/);
});

test("buildHistoryAiAnalysisPrompt records when rollback SQL is unavailable", () => {
  const prompt = buildHistoryAiAnalysisPrompt({
    ...baseEntry,
    rollback_sql: null,
    error: "permission denied",
    success: false,
  });

  assert.match(prompt, /Status: failed/);
  assert.match(prompt, /Error: permission denied/);
  assert.match(prompt, /Rollback SQL:\n\(not available\)/);
});

test("canRollbackHistoryEntry requires connection, database, and rollback SQL", () => {
  assert.equal(canRollbackHistoryEntry({ ...baseEntry, connection_id: "conn-1" }), true);
  assert.equal(canRollbackHistoryEntry({ ...baseEntry, connection_id: "" }), false);
  assert.equal(canRollbackHistoryEntry({ ...baseEntry, connection_id: "conn-1", database: "" }), false);
  assert.equal(canRollbackHistoryEntry({ ...baseEntry, connection_id: "conn-1", rollback_sql: "" }), false);
});
