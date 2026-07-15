import { strict as assert } from "node:assert";
import { test } from "vitest";
import { queryContextObjectRoute } from "../../apps/desktop/src/lib/sql/queryCursorTableTarget.ts";
import type { SqlObjectNavigationTarget } from "../../apps/desktop/src/lib/sql/sqlNavigation.ts";

const tableTarget: SqlObjectNavigationTarget = { name: "orders", database: "analytics", schema: "reporting", type: "table" };
const viewTarget: SqlObjectNavigationTarget = { ...tableTarget, type: "view" };
const materializedViewTarget: SqlObjectNavigationTarget = { ...tableTarget, type: "materialized_view" };

test("routes table context actions with the resolved target payload", () => {
  assert.deepEqual(queryContextObjectRoute("view-data", tableTarget), { event: "viewTableData", payload: [tableTarget] });
  assert.deepEqual(queryContextObjectRoute("edit-table-structure", tableTarget), { event: "editTableStructure", payload: [tableTarget] });
  assert.deepEqual(queryContextObjectRoute("view-ddl", tableTarget), { event: "viewTableDdl", payload: [tableTarget] });
});

test("routes view source actions with editing intent and type fidelity", () => {
  assert.deepEqual(queryContextObjectRoute("edit-view", viewTarget), { event: "openObjectSource", payload: [viewTarget, true] });
  assert.deepEqual(queryContextObjectRoute("view-source", viewTarget), { event: "openObjectSource", payload: [viewTarget, false] });
});

test("preserves materialized view type in every routed payload", () => {
  assert.deepEqual(queryContextObjectRoute("view-data", materializedViewTarget), { event: "viewTableData", payload: [materializedViewTarget] });
  assert.deepEqual(queryContextObjectRoute("edit-view", materializedViewTarget), { event: "openObjectSource", payload: [materializedViewTarget, true] });
  assert.deepEqual(queryContextObjectRoute("view-source", materializedViewTarget), { event: "openObjectSource", payload: [materializedViewTarget, false] });
  assert.deepEqual(queryContextObjectRoute("view-ddl", materializedViewTarget), { event: "viewTableDdl", payload: [materializedViewTarget] });
});
