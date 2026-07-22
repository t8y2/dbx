import { strict as assert } from "node:assert";
import { test } from "vitest";
import { historyConnectionHasSelectedDatabase } from "../../apps/desktop/src/lib/history/historySearch.ts";
import type { HistoryConnectionFilter, HistoryDatabaseFilter } from "../../apps/desktop/src/lib/backend/tauri.ts";

test("database selections narrow only their owning connection", () => {
  const primary: HistoryConnectionFilter = { connection_id: "conn-a", connection_name: "Primary" };
  const replica: HistoryConnectionFilter = { connection_id: "conn-b", connection_name: "Replica" };
  const databases: HistoryDatabaseFilter[] = [{ connection_id: "conn-b", connection_name: "Replica", database: "sales" }];

  assert.equal(historyConnectionHasSelectedDatabase(primary, databases), false);
  assert.equal(historyConnectionHasSelectedDatabase(replica, databases), true);
});

test("legacy database selections use names only when both connection IDs are absent", () => {
  const legacy: HistoryConnectionFilter = { connection_id: "", connection_name: "Legacy" };
  const current: HistoryConnectionFilter = { connection_id: "current", connection_name: "Legacy" };
  const databases: HistoryDatabaseFilter[] = [{ connection_id: "", connection_name: "Legacy", database: "archive" }];

  assert.equal(historyConnectionHasSelectedDatabase(legacy, databases), true);
  assert.equal(historyConnectionHasSelectedDatabase(current, databases), false);
});
