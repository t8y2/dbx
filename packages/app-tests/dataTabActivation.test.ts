import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canActivateExistingDataTableTab, canRefreshDataTableFromSingleActivationDoubleClick, dataTableDoubleClickAction } from "../../apps/desktop/src/lib/tabs/dataTabActivation.ts";
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

test("sidebar can restart a loading tab after superseding its request", () => {
  assert.equal(canActivateExistingDataTableTab(dataTab({ isExecuting: true }), { activateExecuting: false }), false);
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

test("single activation snapshots only successful idle tabs as refreshable", () => {
  assert.equal(canRefreshDataTableFromSingleActivationDoubleClick(undefined), false);
  assert.equal(canRefreshDataTableFromSingleActivationDoubleClick(dataTab()), false);
  assert.equal(canRefreshDataTableFromSingleActivationDoubleClick(dataTab({ isExecuting: true })), false);
  assert.equal(
    canRefreshDataTableFromSingleActivationDoubleClick(
      dataTab({
        result: {
          columns: ["Error"],
          rows: [["connection failed"]],
          affected_rows: 0,
          execution_time_ms: 0,
        },
      }),
    ),
    false,
  );
  assert.equal(
    canRefreshDataTableFromSingleActivationDoubleClick(
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

test("single activation uses missing, restored, error, and busy first-click snapshots even if the tab succeeds before dblclick", () => {
  const successfulAtDoubleClick = dataTab({
    result: {
      columns: ["id"],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
    },
  });
  const errorAtFirstClick = dataTab({
    result: {
      columns: ["Error"],
      rows: [["connection failed"]],
      affected_rows: 0,
      execution_time_ms: 0,
    },
  });
  for (const initialTab of [undefined, dataTab(), errorAtFirstClick, dataTab({ isExecuting: true })]) {
    const refreshAllowed = canRefreshDataTableFromSingleActivationDoubleClick(initialTab);
    assert.equal(dataTableDoubleClickAction(successfulAtDoubleClick, "single", refreshAllowed), "none");
  }
  const refreshAllowed = canRefreshDataTableFromSingleActivationDoubleClick(successfulAtDoubleClick);
  assert.equal(dataTableDoubleClickAction(successfulAtDoubleClick, "single", refreshAllowed), "refresh");
});

test("double activation opens a missing table without a first-click snapshot", () => {
  assert.equal(dataTableDoubleClickAction(undefined, "double"), "open");
});

test("double activation decisions preserve loading, refresh, and recovery behavior", () => {
  assert.equal(dataTableDoubleClickAction(dataTab({ isExecuting: true }), "double"), "activate");
  assert.equal(
    dataTableDoubleClickAction(
      dataTab({
        result: {
          columns: ["id"],
          rows: [[1]],
          affected_rows: 0,
          execution_time_ms: 1,
        },
      }),
      "double",
    ),
    "refresh",
  );
  assert.equal(dataTableDoubleClickAction(dataTab(), "double"), "open");
  assert.equal(
    dataTableDoubleClickAction(
      dataTab({
        result: {
          columns: ["Error"],
          rows: [["connection failed"]],
          affected_rows: 0,
          execution_time_ms: 0,
        },
      }),
      "double",
    ),
    "open",
  );
});
