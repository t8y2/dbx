import { strict as assert } from "node:assert";
import { test } from "vitest";
import { historyEntryMatchesSearch } from "../../apps/desktop/src/lib/history/historySearch.ts";
import type { HistoryEntry, HistorySearchRequest } from "../../apps/desktop/src/lib/backend/tauri.ts";

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "history-1",
    connection_id: "conn-a",
    connection_name: "Primary",
    database: "sales",
    sql: "select * from orders",
    executed_at: "2026-07-18T08:00:00.000Z",
    execution_time_ms: 10,
    success: true,
    activity_kind: "query",
    ...overrides,
  };
}

function request(overrides: Partial<HistorySearchRequest> = {}): HistorySearchRequest {
  return {
    search_text: "",
    connections: [],
    databases: [],
    limit: 100,
    ...overrides,
  };
}

test("matches connection and connection-scoped database filters", () => {
  const scoped = request({
    connections: [{ connection_id: "conn-a", connection_name: "Primary" }],
    databases: [{ connection_id: "conn-a", connection_name: "Primary", database: "sales" }],
  });
  assert.equal(historyEntryMatchesSearch(entry(), scoped), true);
  assert.equal(historyEntryMatchesSearch(entry({ connection_id: "conn-b", connection_name: "Replica" }), scoped), false);
});

test("matches legacy history by connection name only when its id is absent", () => {
  const legacy = request({ connections: [{ connection_id: "", connection_name: "Legacy" }] });
  assert.equal(historyEntryMatchesSearch(entry({ connection_id: "", connection_name: "Legacy" }), legacy), true);
  assert.equal(historyEntryMatchesSearch(entry({ connection_id: "current", connection_name: "Legacy" }), legacy), false);
});

test("combines literal text, status, activity, and time filters", () => {
  const filtered = request({
    search_text: "100%",
    success: false,
    activity_kind: "query",
    started_at: "2026-07-18T00:00:00.000Z",
    ended_at: "2026-07-18T23:59:59.999Z",
  });
  assert.equal(historyEntryMatchesSearch(entry({ sql: "select 100%", success: false }), filtered), true);
  assert.equal(historyEntryMatchesSearch(entry({ sql: "select 1000", success: false }), filtered), false);
  assert.equal(historyEntryMatchesSearch(entry({ sql: "select 100%", success: true }), filtered), false);
});
