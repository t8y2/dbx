import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canActivateExistingDataTableTab } from "../../apps/desktop/src/lib/dataTabActivation.ts";
import type { QueryTab } from "../../apps/desktop/src/types/database.ts";

function dataTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "users",
    connectionId: "conn-1",
    database: "app",
    sql: "select * from users",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode: "data",
    ...overrides,
  };
}

test("activates an existing data table tab while it is still loading", () => {
  assert.equal(canActivateExistingDataTableTab(dataTab({ isExecuting: true })), true);
});

test("activates an existing data table tab with a usable result", () => {
  assert.equal(
    canActivateExistingDataTableTab(
      dataTab({
        result: {
          columns: ["id"],
          rows: [[1]],
          affected_rows: 0,
          execution_time_ms: 1,
        },
      }),
    ),
    true,
  );
});

test("reloads restored data table tabs without a result", () => {
  assert.equal(canActivateExistingDataTableTab(dataTab()), false);
});

test("reloads existing data table tabs showing an error result", () => {
  assert.equal(
    canActivateExistingDataTableTab(
      dataTab({
        result: {
          columns: ["Error"],
          rows: [["MySQL connection failed: Input/output error: No route to host (os error 65)"]],
          affected_rows: 0,
          execution_time_ms: 0,
        },
      }),
    ),
    false,
  );
});
