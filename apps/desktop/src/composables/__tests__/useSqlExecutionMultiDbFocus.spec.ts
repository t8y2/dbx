/**
 * Issue #6189 — SQL Server "focus jumps to the message result".
 *
 * Background:
 *  - `crates/dbx-driver-sqlserver/src/sqlserver.rs` synthesizes a pseudo result with a
 *    single "Message" column and `server_message: true` for any batch segment that
 *    produced only server messages (PRINT / "DBCC execution completed" / ...).
 *  - `stores/queryStore.ts:4727` then picks the first result that HAS COLUMNS as the
 *    active one. The synthesized message grid has a column, so a message result can win.
 *  - `composables/useSqlExecution.ts` (`focusSqlServerDataResult`, shared by both
 *    `doExecute` and `executeTargetSql`) corrects that: when the selected result is a
 *    `server_message` one it re-focuses the first real data result. Before this fix,
 *    `executeTargetSql` (the multi-database execute path) had no such correction.
 */
import { computed, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MULTI_SOURCE_MAX_ROWS_PER_SOURCE } from "@/lib/query/multiSourceResult";
import { useSqlExecution } from "../useSqlExecution";
import { useHistoryStore } from "@/stores/historyStore";
import { useQueryStore } from "@/stores/queryStore";
import type { ConnectionConfig, QueryTab } from "@/types/database";

vi.mock("vue-i18n", () => ({
  createI18n: () => ({ global: { locale: { value: "en" }, setLocaleMessage: vi.fn() } }),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  saveEditorSettings: vi.fn(),
  saveHistory: vi.fn(),
  unlockConnectionWrites: vi.fn(),
  lockConnectionWrites: vi.fn(),
  connectionWriteUnlockState: vi.fn().mockResolvedValue(0),
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function sqlServerConnection(): ConnectionConfig {
  return {
    id: "conn-1",
    name: "SQLServer",
    db_type: "sqlserver",
    host: "localhost",
    port: 1433,
    username: "sa",
    password: "",
  };
}

function queryTab(database = "dbx_sqlserver_demo"): QueryTab {
  return {
    id: "tab-1",
    connectionId: "conn-1",
    database,
    schema: undefined,
    title: "SQL",
    sql: "",
    mode: "query",
    isDirty: false,
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
  };
}

/**
 * What the SQL Server driver really returns for `PRINT N'x'; SELECT 1 AS value;`:
 * the PRINT becomes a synthesized single-column "Message" grid flagged
 * `server_message: true`, followed by the real SELECT result.
 */
function sqlServerMessageFirstResults() {
  const messageResult = {
    columns: ["Message"],
    column_types: ["nvarchar"],
    rows: [["x"]],
    affected_rows: 0,
    execution_time_ms: 1,
    server_message: true,
  } as const;
  const dataResult = {
    columns: ["value"],
    column_types: ["int"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 1,
  };
  return { messageResult, dataResult };
}

describe("SQL Server result focus: doExecute vs executeTargetSql", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("opens message-only executeTargetSql output in the messages view", async () => {
    const tab = { ...queryTab(), sql: "PRINT N'x'" };
    const connection = sqlServerConnection();
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const queryStore = useQueryStore();
    const { messageResult } = sqlServerMessageFirstResults();
    vi.spyOn(queryStore, "executeTabSql").mockImplementation(async () => {
      tab.result = messageResult;
      return true;
    });
    vi.spyOn(queryStore, "getExecutionTab").mockReturnValue(tab);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({
      activeTab: computed(() => tab as QueryTab | undefined),
      activeConnection: computed(() => connection),
      executableSql: computed(() => tab.sql),
      activeOutputView,
    });

    await execution.executeTargetSql({ tab, connection, sql: tab.sql });

    expect(activeOutputView.value).toBe("messages");
    expect(tab.result?.rows).toEqual([["x"]]);
  });

  // ---- control: the single-connection editor path (fixed by be3336c1e) ----
  it("CONTROL doExecute re-focuses the real data result when a message result was selected", async () => {
    const sql = "PRINT N'x'; SELECT 1 AS value;";
    const tab = { ...queryTab(), sql };
    const activeTab = ref<QueryTab | undefined>(tab);
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const { messageResult, dataResult } = sqlServerMessageFirstResults();

    const setActiveResultIndex = vi.spyOn(queryStore, "setActiveResultIndex").mockImplementation((_id, index) => {
      if (!tab.results) return;
      tab.activeResultIndex = index;
      tab.result = tab.results[index];
    });
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      tab.results = [messageResult, dataResult];
      // queryStore.ts:4727 — first result WITH COLUMNS wins, and the message grid has one.
      tab.activeResultIndex = 0;
      tab.result = messageResult;
      return true;
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => sqlServerConnection()),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(setActiveResultIndex).toHaveBeenCalledWith("tab-1", 1);
    expect(tab.activeResultIndex).toBe(1);
    expect(tab.result?.server_message).toBeUndefined();
    expect(tab.result?.rows).toEqual([[1]]);
  });

  it("executeTargetSql focuses the real data result, like doExecute (fix for #6189)", async () => {
    const sql = "PRINT N'x'; SELECT 1 AS value;";
    const tab = { ...queryTab(), sql };
    const connection = sqlServerConnection();
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const { messageResult, dataResult } = sqlServerMessageFirstResults();

    vi.spyOn(queryStore, "setActiveResultIndex").mockImplementation((_id, index) => {
      if (!tab.results) return;
      tab.activeResultIndex = index;
      tab.result = tab.results[index];
    });
    vi.spyOn(queryStore, "executeTabSql").mockImplementation(async () => {
      tab.results = [messageResult, dataResult];
      tab.activeResultIndex = 0;
      tab.result = messageResult;
      return true;
    });
    vi.spyOn(queryStore, "getExecutionTab").mockReturnValue(tab);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => tab as QueryTab | undefined),
      activeConnection: computed(() => connection),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.executeTargetSql({ tab, connection, sql });

    expect(tab.activeResultIndex).toBe(1);
    expect(tab.result?.server_message).toBeUndefined();
    expect(tab.result?.rows).toEqual([[1]]);
  });

  // ---- the "trailing message" shape actually described by #6189 / #5566 ----
  it("executeTargetSql keeps the first data result when the message result is last", async () => {
    const sql = "SELECT 1 AS a; SELECT 2 AS b; PRINT N'DBCC execution completed.';";
    const tab = { ...queryTab(), sql };
    const connection = sqlServerConnection();
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();

    const first = { columns: ["a"], column_types: ["int"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    const second = { columns: ["b"], column_types: ["int"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 };
    const trailingMessage = {
      columns: ["Message"],
      column_types: ["nvarchar"],
      rows: [["DBCC execution completed."]],
      affected_rows: 0,
      execution_time_ms: 1,
      server_message: true,
    } as const;

    vi.spyOn(queryStore, "executeTabSql").mockImplementation(async () => {
      tab.results = [first, second, trailingMessage];
      tab.activeResultIndex = 0;
      tab.result = first;
      return true;
    });
    vi.spyOn(queryStore, "getExecutionTab").mockReturnValue(tab);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => tab as QueryTab | undefined),
      activeConnection: computed(() => connection),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.executeTargetSql({ tab, connection, sql });

    expect(tab.activeResultIndex).toBe(0);
    expect(tab.result?.rows).toEqual([[1]]);
  });
});

describe("preservedResultIndex staleness theory", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("doExecute never asks the store to preserve the previous active result index", async () => {
    const sql = "SELECT 1 AS a; SELECT 2 AS b; PRINT N'trailing';";
    const tab = { ...queryTab(), sql, results: undefined, activeResultIndex: 2 } as QueryTab;
    const activeTab = ref<QueryTab | undefined>(tab);
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();

    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      tab.results = [
        { columns: ["a"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
        { columns: ["Message"], rows: [["trailing"]], affected_rows: 0, execution_time_ms: 1, server_message: true },
      ];
      tab.activeResultIndex = 0;
      tab.result = tab.results[0];
      return true;
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => sqlServerConnection()),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    const options = executeCurrentSql.mock.calls[0]?.[1] ?? {};
    // queryStore.ts:238-241 only reuses the previous index when this flag is true,
    // so without it a new execution can never inherit a stale "last card" index.
    expect(options).not.toHaveProperty("preserveActiveResultIndex");
    expect(tab.activeResultIndex).toBe(0);
  });

  it("executeTargetSql never asks the store to preserve the previous active result index", async () => {
    const sql = "SELECT 1 AS a; PRINT N'trailing';";
    const tab = { ...queryTab(), sql, activeResultIndex: 2 } as QueryTab;
    const connection = sqlServerConnection();
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();

    const executeTabSql = vi.spyOn(queryStore, "executeTabSql").mockImplementation(async () => {
      tab.results = [
        { columns: ["a"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
        { columns: ["Message"], rows: [["trailing"]], affected_rows: 0, execution_time_ms: 1, server_message: true },
      ];
      tab.activeResultIndex = 0;
      tab.result = tab.results[0];
      return true;
    });
    vi.spyOn(queryStore, "getExecutionTab").mockReturnValue(tab);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => tab as QueryTab | undefined),
      activeConnection: computed(() => connection),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.executeTargetSql({ tab, connection, sql });

    const options = executeTabSql.mock.calls[0]?.[2] ?? {};
    expect(options).not.toHaveProperty("preserveActiveResultIndex");
    expect(tab.activeResultIndex).toBe(0);
  });

  it("reads one multi-database target up to the per-source row cap, not just the editor page", async () => {
    const sql = "SELECT 1 AS value";
    const tab = { ...queryTab(), sql };
    const connection = sqlServerConnection();
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeTabSql = vi.spyOn(queryStore, "executeTabSql").mockImplementation(async () => true);
    vi.spyOn(queryStore, "getExecutionTab").mockReturnValue(tab);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => tab as QueryTab | undefined),
      activeConnection: computed(() => connection),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.executeTargetSql({ tab, connection, sql });

    expect(MULTI_SOURCE_MAX_ROWS_PER_SOURCE).toBe(10_000);
    expect(executeTabSql.mock.calls[0]?.[2]).toMatchObject({ pagination: { limit: MULTI_SOURCE_MAX_ROWS_PER_SOURCE, offset: 0 } });
  });

  it("does not count the time an operator spends on the danger confirmation", async () => {
    vi.useFakeTimers();
    try {
      const sql = "UPDATE t_order SET shard_no = 999";
      const tab = { ...queryTab(), sql };
      const connection = sqlServerConnection();
      const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
      const queryStore = useQueryStore();
      vi.spyOn(queryStore, "executeTabSql").mockImplementation(async () => {
        tab.result = { columns: [], rows: [], affected_rows: 2, execution_time_ms: 1 };
        return true;
      });
      vi.spyOn(queryStore, "getExecutionTab").mockReturnValue(tab);
      const history = vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

      let answer: ((confirmed: boolean) => void) | undefined;
      const execution = useSqlExecution({
        activeTab: computed(() => tab as QueryTab | undefined),
        activeConnection: computed(() => connection),
        executableSql: computed(() => sql),
        activeOutputView,
        requestDangerConfirmation: () => new Promise<boolean>((resolve) => (answer = resolve)),
      });

      const running = execution.executeTargetSql({ tab, connection, sql });
      await vi.advanceTimersByTimeAsync(9_000);
      answer?.(true);
      const result = await running;

      // The batch is parked on the prompt, so neither the target nor the history
      // row may report those nine seconds as execution time.
      expect(result.status).toBe("success");
      expect(result.durationMs).toBeLessThan(1_000);
      expect(history.mock.calls[0]?.[0]).toMatchObject({ execution_time_ms: expect.any(Number) });
      expect((history.mock.calls[0]?.[0] as { execution_time_ms: number }).execution_time_ms).toBeLessThan(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
