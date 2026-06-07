import { strict as assert } from "node:assert";
import test from "node:test";
import { buildSelectedTablesPayload } from "../../apps/desktop/src/lib/databaseExportSelection.ts";

test("omits selected table payload when every table is selected", () => {
  assert.equal(buildSelectedTablesPayload(["users", "orders"], ["users", "orders"]), undefined);
});

test("builds selected table payload for a subset in table order", () => {
  assert.deepEqual(buildSelectedTablesPayload(["users", "orders", "logs"], ["logs", "users"]), ["users", "logs"]);
});

test("builds an empty payload when no table is selected", () => {
  assert.deepEqual(buildSelectedTablesPayload(["users"], []), []);
});
