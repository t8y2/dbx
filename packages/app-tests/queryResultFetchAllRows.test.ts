import assert from "node:assert/strict";
import { computed } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { test, vi } from "vitest";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { appendQueryResultSegment, useQueryStore } from "../../apps/desktop/src/stores/queryStore.ts";
import { useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";
import { isFetchingAllRows } from "../../apps/desktop/src/lib/dataGrid/queryResultFetchAllRows.ts";
import type { ConnectionConfig, QueryResult, QueryTab } from "../../apps/desktop/src/types/database.ts";

vi.mock("vue-i18n", async () => {
  const actual = await vi.importActual<typeof import("vue-i18n")>("vue-i18n");
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  };
});

const toastCalls: unknown[] = [];
vi.mock("@/composables/useToast", () => ({
  useToast: () => ({
    toast: (...args: unknown[]) => toastCalls.push(args),
  }),
}));

function installMemoryStorage() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function conn(id: string): ConnectionConfig {
  return { id, name: id, db_type: "mysql", host: "localhost", port: 3306, username: "root", password: "" };
}

function segment(rows: number, startingAt: number, hasMore: boolean): QueryResult {
  return {
    columns: ["id"],
    rows: Array.from({ length: rows }, (_, i) => [startingAt + i]),
    affected_rows: 0,
    execution_time_ms: 1,
    has_more: hasMore,
  };
}

function seedQueryTab(queryStore: ReturnType<typeof useQueryStore>, connectionId: string): QueryTab {
  // forceNew: repeated calls with the same (connectionId, database, title, mode)
  // would otherwise reuse a matching existing tab instead of creating a new one.
  const tabId = queryStore.createTab(connectionId, "app", "db", "query", undefined, undefined, undefined, { forceNew: true });
  const tab = queryStore.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.sql = "select * from users";
  tab.lastExecutedSql = "select * from users";
  tab.resultBaseSql = "select * from users";
  tab.result = segment(1, 0, true);
  tab.resultPageLimit = 100;
  tab.resultPageOffset = 0;
  return tab;
}

async function withHarness(run: (ctx: { queryStore: ReturnType<typeof useQueryStore>; settingsStore: ReturnType<typeof useSettingsStore>; useDataGridActions: typeof import("../../apps/desktop/src/composables/useDataGridActions.ts").useDataGridActions }) => Promise<void>) {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const connectionStore = useConnectionStore();
    connectionStore.addEphemeralConnection(conn("mysql-1"));
    const queryStore = useQueryStore();
    const settingsStore = useSettingsStore();
    const { useDataGridActions } = await import("../../apps/desktop/src/composables/useDataGridActions.ts");
    await run({ queryStore, settingsStore, useDataGridActions });
  } finally {
    restoreStorage();
  }
}

test("fetch-all-rows appends sequential batches until a short page ends the loop", async () => {
  await withHarness(async ({ queryStore, settingsStore, useDataGridActions }) => {
    settingsStore.updateEditorSettings({ queryResultMaxRowsEnabled: false });
    const tab = seedQueryTab(queryStore, "mysql-1");
    const offsetsSeen: number[] = [];
    let calls = 0;
    vi.spyOn(queryStore, "executeTabSql").mockImplementation(async (id, _sql, options) => {
      calls++;
      const offset = options?.pagination?.offset ?? 0;
      offsetsSeen.push(offset);
      const t = queryStore.tabs.find((x) => x.id === id)!;
      const rowsInBatch = calls < 3 ? 10_000 : 500; // third batch is short -> signals "done"
      const nextSegment = segment(rowsInBatch, offset, false);
      t.result = appendQueryResultSegment(t.result!, nextSegment, options!.appendResult!.maxRows);
      return true;
    });

    const actions = useDataGridActions(computed(() => tab));
    await actions.onFetchAllRows(tab.id);

    assert.equal(calls, 3);
    assert.deepEqual(offsetsSeen, [1, 10_001, 20_001]);
    assert.equal(tab.result?.rows.length, 1 + 10_000 + 10_000 + 500);
    assert.equal(isFetchingAllRows(tab.id), false);
  });
});

test("fetch-all-rows stops at the configured query result max rows cap", async () => {
  await withHarness(async ({ queryStore, settingsStore, useDataGridActions }) => {
    settingsStore.updateEditorSettings({ queryResultMaxRowsEnabled: true, queryResultMaxRows: 25_000 });
    const tab = seedQueryTab(queryStore, "mysql-1");
    toastCalls.length = 0;
    let calls = 0;
    vi.spyOn(queryStore, "executeTabSql").mockImplementation(async (id, _sql, options) => {
      calls++;
      const offset = options?.pagination?.offset ?? 0;
      const limit = options?.pagination?.limit ?? 0;
      const t = queryStore.tabs.find((x) => x.id === id)!;
      // Unlimited upstream supply: the backend always has more than requested.
      const nextSegment = segment(limit, offset, true);
      t.result = appendQueryResultSegment(t.result!, nextSegment, options!.appendResult!.maxRows);
      return true;
    });

    const actions = useDataGridActions(computed(() => tab));
    await actions.onFetchAllRows(tab.id);

    assert.equal(tab.result?.rows.length, 25_000, "must stop exactly at the cap, never exceed it");
    assert.equal(tab.result?.has_more, false);
    assert.ok(calls >= 3, "cap enforcement must span multiple shrinking batches near the boundary");
    assert.equal(toastCalls.length, 1, "reaching the cap must be surfaced to the user, exactly once");
  });
});

test("stopping fetch-all-rows halts the loop after the in-flight batch", async () => {
  await withHarness(async ({ queryStore, settingsStore, useDataGridActions }) => {
    settingsStore.updateEditorSettings({ queryResultMaxRowsEnabled: false });
    const tab = seedQueryTab(queryStore, "mysql-1");
    let calls = 0;
    const actions = useDataGridActions(computed(() => tab));
    vi.spyOn(queryStore, "executeTabSql").mockImplementation(async (id, _sql, options) => {
      calls++;
      const offset = options?.pagination?.offset ?? 0;
      const t = queryStore.tabs.find((x) => x.id === id)!;
      const nextSegment = segment(10_000, offset, true);
      t.result = appendQueryResultSegment(t.result!, nextSegment, options!.appendResult!.maxRows);
      if (calls === 1) actions.onStopFetchAllRows(id); // simulate the user clicking "stop" right after batch 1 lands
      return true;
    });

    await actions.onFetchAllRows(tab.id);

    assert.equal(calls, 1, "must not start a second batch once stop was requested");
    assert.equal(tab.result?.rows.length, 1 + 10_000);
    assert.equal(isFetchingAllRows(tab.id), false);
  });
});

test("stopping one tab's fetch-all-rows does not affect another tab's in-flight loop", async () => {
  // Regression test for the bug where a stop button read whichever tab was
  // currently active instead of the tab the loop was started on: here tabB
  // gets stopped while tabA keeps running concurrently, and each loop only
  // ever targets the tabId it was invoked with.
  await withHarness(async ({ queryStore, settingsStore, useDataGridActions }) => {
    settingsStore.updateEditorSettings({ queryResultMaxRowsEnabled: false });
    const tabA = seedQueryTab(queryStore, "mysql-1");
    const tabB = seedQueryTab(queryStore, "mysql-1");
    const callsByTab = new Map<string, number>();
    const actions = useDataGridActions(computed(() => tabA));
    vi.spyOn(queryStore, "executeTabSql").mockImplementation(async (id, _sql, options) => {
      const callCount = (callsByTab.get(id) ?? 0) + 1;
      callsByTab.set(id, callCount);
      const offset = options?.pagination?.offset ?? 0;
      const t = queryStore.tabs.find((x) => x.id === id)!;
      const isTabAFinalBatch = id === tabA.id && callCount === 3;
      const rowsInBatch = isTabAFinalBatch ? 500 : 10_000;
      const nextSegment = segment(rowsInBatch, offset, !isTabAFinalBatch);
      t.result = appendQueryResultSegment(t.result!, nextSegment, options!.appendResult!.maxRows);
      if (id === tabB.id && callCount === 1) actions.onStopFetchAllRows(tabB.id);
      return true;
    });

    const runA = actions.onFetchAllRows(tabA.id);
    const runB = actions.onFetchAllRows(tabB.id);
    await Promise.all([runA, runB]);

    assert.equal(callsByTab.get(tabB.id), 1, "tabB must stop after exactly one batch");
    assert.equal(tabB.result?.rows.length, 1 + 10_000);
    assert.equal(callsByTab.get(tabA.id), 3, "tabA must run to its own natural end, unaffected by tabB's stop");
    assert.equal(tabA.result?.rows.length, 1 + 10_000 + 10_000 + 500);
  });
});

test("a batch failure stops the loop, keeps the rows already loaded, and reports the error", async () => {
  await withHarness(async ({ queryStore, settingsStore, useDataGridActions }) => {
    settingsStore.updateEditorSettings({ queryResultMaxRowsEnabled: false });
    const tab = seedQueryTab(queryStore, "mysql-1");
    let calls = 0;
    toastCalls.length = 0;
    vi.spyOn(queryStore, "executeTabSql").mockImplementation(async (id, _sql, options) => {
      calls++;
      if (calls === 2) throw new Error("connection reset");
      const offset = options?.pagination?.offset ?? 0;
      const t = queryStore.tabs.find((x) => x.id === id)!;
      const nextSegment = segment(10_000, offset, true);
      t.result = appendQueryResultSegment(t.result!, nextSegment, options!.appendResult!.maxRows);
      return true;
    });

    const actions = useDataGridActions(computed(() => tab));
    await assert.doesNotReject(() => actions.onFetchAllRows(tab.id));

    assert.equal(calls, 2);
    assert.equal(tab.result?.rows.length, 1 + 10_000, "rows from the successful first batch must be kept");
    assert.equal(isFetchingAllRows(tab.id), false);
    assert.equal(toastCalls.length, 1, "the failure must be surfaced to the user");
  });
});

test("a second concurrent call for the same tab is a no-op while one loop is already running", async () => {
  await withHarness(async ({ queryStore, settingsStore, useDataGridActions }) => {
    settingsStore.updateEditorSettings({ queryResultMaxRowsEnabled: false });
    const tab = seedQueryTab(queryStore, "mysql-1");
    let calls = 0;
    vi.spyOn(queryStore, "executeTabSql").mockImplementation(async (id, _sql, options) => {
      calls++;
      const offset = options?.pagination?.offset ?? 0;
      const t = queryStore.tabs.find((x) => x.id === id)!;
      const rowsInBatch = calls === 1 ? 10_000 : 100; // second batch is short -> natural end
      const nextSegment = segment(rowsInBatch, offset, false);
      t.result = appendQueryResultSegment(t.result!, nextSegment, options!.appendResult!.maxRows);
      return true;
    });

    const actions = useDataGridActions(computed(() => tab));
    const first = actions.onFetchAllRows(tab.id);
    const second = actions.onFetchAllRows(tab.id);
    await second;
    assert.equal(isFetchingAllRows(tab.id), true, "the first loop must still be running after the duplicate call returns");
    await first;

    assert.equal(calls, 2, "the duplicate call must not have started a second overlapping loop");
    assert.equal(isFetchingAllRows(tab.id), false);
  });
});
