import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, it, vi } from "vitest";
import type { QueryMessage, QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({ executeMulti: vi.fn(), subscribe: vi.fn(), cleanup: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/api", () => ({
  executeMulti: mocks.executeMulti,
  subscribeQueryMessages: mocks.subscribe,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  prepareQueryPaginationExecutionPlan: vi.fn(async (options) => ({ sqlToExecute: options.sql, useAgentResultSession: false })),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: () => ({ id: "pg", name: "PostgreSQL", db_type: "postgres", database: "app", query_timeout_secs: 30 }),
    lookupLocalCompletionTables: () => [],
    recordConnectionLostError: vi.fn(),
  }),
}));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { pageSize: 100, autoCalculateTotalRows: false } }) }));

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  mocks.subscribe.mockResolvedValue(mocks.cleanup);
});

const notice: QueryMessage = { severity: "NOTICE", message: "running output" };

it.each([false, true])("retains streamed output and cleans up listeners (failed=%s)", async (failed) => {
  let resolve!: (results: QueryResult[]) => void;
  let reject!: (error: Error) => void;
  mocks.executeMulti.mockReturnValue(
    new Promise<QueryResult[]>((resolveQuery, rejectQuery) => {
      resolve = resolveQuery;
      reject = rejectQuery;
    }),
  );
  const { useQueryStore } = await import("../queryStore");
  const store = useQueryStore();
  const tabId = store.createTab("pg", "app", "Query");
  const run = store.executeTabSql(tabId, "DO $$ BEGIN RAISE NOTICE 'running output'; END $$");
  await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalled());
  const listener = mocks.subscribe.mock.calls[0][1];
  listener([notice, notice]);
  expect(store.tabs[0].liveQueryMessages).toEqual([notice, notice]);
  if (failed) reject(new Error("Query canceled"));
  else resolve([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, messages: [notice, notice] }]);
  await run;
  expect(store.tabs[0].result?.messages).toEqual([notice, notice]);
  expect(store.tabs[0].liveQueryMessages).toBeUndefined();
  expect(mocks.cleanup).toHaveBeenCalledOnce();
  listener([{ ...notice, message: "late output" }]);
  expect(store.tabs[0].result?.messages).toEqual([notice, notice]);
});
