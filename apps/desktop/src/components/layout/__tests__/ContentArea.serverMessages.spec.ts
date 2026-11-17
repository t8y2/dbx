// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseType, QueryMessage, QueryResult, QueryTab, TabOutputView } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/transfer/QueryResultTransferDialog.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", { "data-test": "data-grid" }, slots["result-toolbar-leading"]?.({ compact: false })),
  }),
}));
vi.mock("@/lib/common/clipboard", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/common/clipboard")>()), copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/query/queryExecutionLog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query/queryExecutionLog")>();
  return { ...actual, queryExecutionLog: vi.fn(actual.queryExecutionLog) };
});

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { queryExecutionLog } from "@/lib/query/queryExecutionLog";
import { hasQueryOutput } from "@/lib/query/queryOutput";
import { copyToClipboard } from "@/lib/common/clipboard";
import * as api from "@/lib/backend/api";
import * as tauriRuntime from "@/lib/backend/tauriRuntime";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  window.localStorage?.clear();
  vi.mocked(queryExecutionLog).mockClear();
  vi.mocked(copyToClipboard).mockClear();
  vi.restoreAllMocks();
});

async function mountResults(results: QueryResult[], activeIndex: number, overrides: Partial<QueryTab> = {}, databaseType: DatabaseType = "sqlserver") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "connection", name: "Connection", db_type: databaseType, host: "localhost", port: 1433, username: "", password: "" };
  useConnectionStore().connections = [connection];
  const tab = reactive<QueryTab>({ id: "query", title: "Query", connectionId: connection.id, database: "app", mode: "query", sql: "EXEC demo", isExecuting: false, results, result: results[activeIndex], activeResultIndex: activeIndex, ...overrides });
  useQueryStore().tabs.push(tab);
  const state = reactive({ view: "result" as TabOutputView });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ContentArea, {
          activeTab: tab,
          activeConnection: connection,
          activeOutputView: state.view,
          executableSql: "",
          hasExecutableSql: false,
          formatSqlRequest: null,
          compressSqlRequest: null,
          keywordCaseRequest: null,
          selectedSql: "",
          cursorPos: 0,
          resultOnly: true,
          blockDangerousRedisCommands: false,
          "onUpdate:activeOutputView": (_tabId: string, view: string) => {
            state.view = view as typeof state.view;
          },
        }),
    }),
  );
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: { en: { tabs: { resultN: "Result {n}", allResults: "All results ({count})" }, grid: { rowsAffected: "Affected rows: {count}" }, queryMessages: { code: "Code: {code}" }, executionSummary: { time: "Time", statuses: { success: "Success", error: "Failed", skipped: "Skipped" } } } },
      missingWarn: false,
      fallbackWarn: false,
    }),
  );
  app.mount(host);
  cleanups.push(() => app.unmount());
  await nextTick();
  await nextTick();
  return { host, state, tab };
}

describe("SQL Server messages in the result surface", () => {
  const message: QueryResult = { columns: ["Message"], rows: [["before notice"]], affected_rows: 0, execution_time_ms: 1, server_message: true };
  const data: QueryResult = { columns: ["Message"], rows: [["real data"]], affected_rows: 0, execution_time_ms: 1 };

  it("shows only three result tabs and preserves both message blocks in Messages", async () => {
    const { host, state } = await mountResults([message, data, { ...message, rows: [["after notice"]] }, { ...data, rows: [] }, data], 1);
    expect([...host.querySelectorAll(".result-set-scroll button")].map((button) => button.textContent?.trim())).toEqual(["Result 1", "Result 2", "Result 3"]);
    state.view = "messages";
    await nextTick();
    expect(host.textContent).toContain("before notice");
    expect(host.textContent).toContain("after notice");
    expect(host.textContent).not.toContain("real data");
  });

  it.each([false, true])("redirects restored message output without a fake grid (mixed=%s)", async (mixed) => {
    const { host, state } = await mountResults(mixed ? [message, data] : [message], 0);
    expect(state.view).toBe("messages");
    expect(host.textContent).toContain("before notice");
    expect(host.querySelector('[data-test="data-grid"]')).toBeNull();
  });
});

describe("live server output", () => {
  it("opens Messages while running and retains output after cancellation", async () => {
    const { host, state, tab } = await mountResults([], 0);
    tab.isExecuting = true;
    await nextTick();
    tab.liveQueryMessages = [{ severity: "NOTICE", message: "running output" }];
    await nextTick();
    expect(state.view).toBe("messages");
    expect(host.textContent).toContain("running output");
    tab.isExecuting = false;
    await nextTick();
    expect(host.textContent).toContain("running output");
    expect(host.querySelector('[data-test="data-grid"]')).toBeNull();
  });

  it("marks autoSwitchedToMessagesDuringExecution in tab uiState when live messages arrive (#11822)", async () => {
    const { state, tab } = await mountResults([], 0);
    tab.isExecuting = true;
    await nextTick();
    tab.liveQueryMessages = [{ severity: "INFO", message: "function info message" }];
    await nextTick();
    expect(state.view).toBe("messages");
    expect(useQueryStore().tabs.find((t) => t.id === tab.id)?.uiState?.autoSwitchedToMessagesDuringExecution).toBe(true);
  });

  it("clears autoSwitchedToMessagesDuringExecution when user explicitly selects an output view (#11822)", async () => {
    const { host, state, tab } = await mountResults([], 0);
    tab.isExecuting = true;
    await nextTick();
    tab.liveQueryMessages = [{ severity: "INFO", message: "function info message" }];
    await nextTick();
    expect(state.view).toBe("messages");
    expect(useQueryStore().tabs.find((t) => t.id === tab.id)?.uiState?.autoSwitchedToMessagesDuringExecution).toBe(true);

    tab.result = { columns: ["val"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    tab.results = [tab.result];
    await nextTick();

    const buttons = host.querySelectorAll<HTMLButtonElement>("[data-query-result-view-switcher] button");
    buttons[0]?.click();
    await nextTick();
    expect(state.view).toBe("result");
    expect(useQueryStore().tabs.find((t) => t.id === tab.id)?.uiState?.autoSwitchedToMessagesDuringExecution).toBe(false);
  });
});

describe("SQL execution logs in Messages", () => {
  const statements = ["UPDATE `device` SET `device_name` = `device_name` WHERE 1 = 0", "UPDATE `device` SET `device_id` = `device_id` WHERE 1 = 0"];
  const results: QueryResult[] = statements.map((sql, index) => ({ columns: [], rows: [], affected_rows: 0, execution_time_ms: index + 12, sourceStatement: sql, statement_index: index }));

  it("shows both zero-row updates and their timing without requiring a server notice", async () => {
    const { host, state, tab } = await mountResults(results, 0, {}, "mysql");
    // Adding logs must not change the configured/default output view.
    expect(state.view).toBe("summary");
    const switcher = host.querySelector("[data-query-result-view-switcher]")!;
    const messagesButton = [...switcher.querySelectorAll("button")].find((button) => button.textContent?.includes("tabs.messages"))!;
    expect(messagesButton).toBeTruthy();
    expect(messagesButton.disabled).toBe(false);
    messagesButton.click();
    await nextTick();
    expect(state.view).toBe("messages");
    const contents = host.querySelector("[data-native-clipboard]")!;
    for (const statement of statements) expect(contents.textContent).toContain(statement);
    expect(contents.textContent?.match(/Affected rows: 0/g)).toHaveLength(2);
    expect(contents.textContent).toContain("12 ms");
    expect(contents.textContent).toContain("13 ms");

    tab.result = results[1];
    tab.activeResultIndex = 1;
    await nextTick();
    for (const statement of statements) expect(contents.textContent).toContain(statement);
  });

  it("retains original notices and error metadata alongside the log", async () => {
    const notice = { severity: "WARNING", message: "server warning", code: "01000", detail: "server detail", hint: "server hint" };
    const { host, state } = await mountResults([{ ...results[0], messages: [notice] }], 0, {}, "mysql");
    state.view = "messages";
    await nextTick();
    const text = host.querySelector("[data-native-clipboard]")!.textContent!;
    expect(text).toContain(statements[0]);
    for (const value of [notice.message, notice.detail, notice.hint, notice.code]) expect(text).toContain(value);
    expect(text.match(/server warning/g)).toHaveLength(1);
  });

  it.each([false, true])("does not mix retained notices into the next execution log (auto-keep=%s)", async (autoKeep) => {
    const oldResult = { ...results[0], sourceExecutionId: "old", messages: [{ severity: "INFO", message: "old notice" }] };
    const { host, state, tab } = await mountResults(
      [oldResult],
      0,
      {
        isExecuting: true,
        executionId: "new",
        ...(autoKeep ? { resultAutoSave: true, activeResultRunId: "old-run", executingResultRunId: null } : {}),
        liveQueryMessages: [],
        batchSqlExecution: { executionId: "new", submittedSql: statements[1], editorFingerprint: "new", sourceOffset: 0, completed: 0, total: 1, startedAt: 1, items: [{ statementIndex: 0, sql: statements[1], from: 0, to: statements[1].length, status: "running" }] },
      },
      "mysql",
    );
    state.view = "messages";
    await nextTick();
    const contents = host.querySelector("[data-native-clipboard]")!;
    expect(contents.textContent).toContain(statements[1]);
    expect(contents.textContent).not.toContain("old notice");
    expect(contents.textContent).not.toContain(statements[0]);
    tab.liveQueryMessages = [{ severity: "NOTICE", message: "new notice" }];
    await nextTick();
    expect(contents.textContent).toContain("new notice");
    expect(contents.textContent).not.toContain("old notice");
  });

  it("keeps historical messages separate from a different running query", async () => {
    const oldResult = { ...results[0], sourceExecutionId: "old", messages: [{ severity: "INFO", message: "historical notice" }] };
    const { host, state } = await mountResults([oldResult], 0, { isExecuting: true, executionId: "new", activeResultRunId: "old-run", executingResultRunId: "new-run", resultRunSelectionExecutionId: "new", liveQueryMessages: [{ severity: "INFO", message: "unrelated live notice" }] }, "mysql");
    state.view = "messages";
    await nextTick();
    const text = host.querySelector("[data-native-clipboard]")!.textContent!;
    expect(text).toContain(statements[0]);
    expect(text).toContain("historical notice");
    expect(text).not.toContain("unrelated live notice");
  });

  it.each([false, true])("restores one run's SQL and notices in Messages and Copy all after cancelling a new query (streamed=%s)", async (streamed) => {
    const { host, state, tab } = await mountResults([], 0, { resultAutoSave: true, autoCommit: true }, "mysql");
    const store = useQueryStore();
    vi.spyOn(useConnectionStore(), "ensureConnected").mockResolvedValue(undefined);
    vi.spyOn(tauriRuntime, "isTauriRuntime").mockReturnValue(true);
    const listeners: Array<(messages: QueryMessage[]) => void> = [];
    vi.spyOn(api, "subscribeQueryMessages").mockImplementation(async (_executionId, onMessages) => {
      listeners.push(onMessages);
      return () => undefined;
    });
    vi.spyOn(api, "prepareQueryPaginationExecutionPlan").mockImplementation(async (options) => ({ sqlToExecute: options.sql, useAgentResultSession: false }));
    vi.spyOn(api, "closeClientConnectionSession").mockResolvedValue(true);
    vi.spyOn(api, "closeQuerySession").mockResolvedValue(true);
    vi.spyOn(api, "analyzeEditableQueryEditability").mockResolvedValue({ editable: false, reason: "multiple-statements" });
    vi.spyOn(api, "saveOpenTabsState").mockResolvedValue(undefined);
    vi.spyOn(api, "cancelQuery").mockResolvedValue(true);
    const oldSql = "SELECT 'retained query' AS id";
    const cancelledSql = "SELECT 'cancelled query' AS id";
    const execute = vi.spyOn(api, "executeMulti").mockResolvedValueOnce([{ columns: ["id"], rows: [["retained query"]], affected_rows: 0, execution_time_ms: 12, messages: [{ severity: "NOTICE", message: "retained notice" }] }]);
    await store.executeTabSql(tab.id, oldSql);
    expect(tab.activeResultRunId).toBeTruthy();
    const retainedRunId = tab.activeResultRunId;

    let rejectQuery!: (error: Error) => void;
    execute.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectQuery = reject;
        }),
    );
    const executing = store.executeTabSql(tab.id, cancelledSql);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    state.view = "messages";
    if (streamed) listeners[1]!([{ severity: "NOTICE", message: "cancelled query notice" }]);
    await nextTick();
    expect(host.querySelector("[data-native-clipboard]")?.textContent).toContain(cancelledSql);
    if (streamed) expect(host.querySelector("[data-native-clipboard]")?.textContent).toContain("cancelled query notice");

    const cancelling = store.cancelTabExecution(tab.id);
    rejectQuery(new Error("Query canceled"));
    await cancelling;
    await executing;
    await nextTick();
    expect(tab.activeResultRunId).toBe(retainedRunId);
    const contents = host.querySelector("[data-native-clipboard]")!;
    expect(contents.textContent).toContain(oldSql);
    expect(contents.textContent).toContain("retained notice");
    expect(contents.textContent).toContain("Time: 12 ms");
    expect(contents.textContent).not.toContain(cancelledSql);
    expect(contents.textContent).not.toContain("cancelled query notice");
    contents.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick();
    expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(`[INFO] executionSummary.sql #1 · Success\n${oldSql}\n> Affected rows: 0\n> Time: 12 ms\n\n[NOTICE] retained notice`);
  });

  it("keeps the first batch log visible and copyable after cancellation before dispatch", async () => {
    const { host, state, tab } = await mountResults([], 0, { autoCommit: true }, "mysql");
    const store = useQueryStore();
    vi.spyOn(useConnectionStore(), "ensureConnected").mockResolvedValue(undefined);
    vi.spyOn(api, "closeClientConnectionSession").mockResolvedValue(true);
    vi.spyOn(api, "closeQuerySession").mockResolvedValue(true);
    vi.spyOn(api, "saveOpenTabsState").mockResolvedValue(undefined);
    // No SQL has reached the backend yet, so it has nothing to cancel.
    vi.spyOn(api, "cancelQuery").mockResolvedValue(false);
    const execute = vi.spyOn(api, "executeMulti").mockResolvedValue([]);
    const executeWithProgress = vi.spyOn(api, "executeMultiWithProgress").mockResolvedValue([]);
    let release!: () => void;
    const preparing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = vi.spyOn(api, "prepareQueryPaginationExecutionPlan").mockImplementation(async (options) => {
      await preparing;
      return { sqlToExecute: options.sql, useAgentResultSession: false };
    });
    const running = store.executeTabSql(tab.id, statements.join(";\n"));
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    await nextTick();
    expect(host.querySelector("[data-query-result-view-switcher]")).not.toBeNull();
    await store.cancelTabExecution(tab.id);
    release();
    await running;
    await nextTick();
    expect(execute).not.toHaveBeenCalled();
    expect(executeWithProgress).not.toHaveBeenCalled();
    expect(tab.result).toBeUndefined();
    expect(tab.results?.length ?? 0).toBe(0);
    expect(tab.batchSqlExecution?.items.map((item) => item.status)).toEqual(["skipped", "skipped"]);
    // SqlEditorWorkspace uses the same predicate to show the shared pane.
    expect(hasQueryOutput(tab)).toBe(true);
    expect(state.view).toBe("summary");
    const switcher = host.querySelector("[data-query-result-view-switcher]");
    expect(switcher).not.toBeNull();
    const messagesButton = [...switcher!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("tabs.messages"))!;
    expect(messagesButton.disabled).toBe(false);
    messagesButton.click();
    await nextTick();
    expect(state.view).toBe("messages");
    const contents = host.querySelector("[data-native-clipboard]")!;
    for (const statement of statements) expect(contents.textContent).toContain(statement);
    expect(contents.textContent?.match(/Skipped/g)).toHaveLength(2);
    contents.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick();
    expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(`[INFO] executionSummary.sql #1 · Skipped\n${statements[0]}\n\nexecutionSummary.sql #2 · Skipped\n${statements[1]}`);
  });

  it("formats a large batch only while Messages is visible and keeps copied text complete", async () => {
    const total = 5000;
    const items = Array.from({ length: total }, (_, statementIndex) => ({ statementIndex, sql: `UPDATE device SET device_id = device_id WHERE id = ${statementIndex}`, from: 0, to: 1, status: "pending" as const }));
    const oldGrid: QueryResult = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, sourceExecutionId: "old" };
    const { host, state, tab } = await mountResults(
      [oldGrid],
      0,
      {
        isExecuting: true,
        executionId: "new",
        batchSqlExecution: { executionId: "new", submittedSql: "batch", editorFingerprint: "new", sourceOffset: 0, completed: 0, total, startedAt: 1, items },
      },
      "mysql",
    );
    expect(state.view).toBe("result");
    expect(queryExecutionLog).not.toHaveBeenCalled();
    const messagesButton = () => [...host.querySelectorAll<HTMLButtonElement>("[data-query-result-view-switcher] button")].find((button) => button.getAttribute("aria-label")?.startsWith("tabs.messages"))!;
    await vi.waitFor(() => expect(messagesButton()).toBeDefined());
    expect(messagesButton().disabled).toBe(false);
    expect(messagesButton().getAttribute("aria-label")).toBe("tabs.messages (1)");

    for (let index = 0; index < 3; index++) {
      Object.assign(tab.batchSqlExecution!.items[index]!, { status: "success", affectedRows: index, executionTimeMs: index + 1 });
      tab.batchSqlExecution!.completed++;
      await nextTick();
    }
    tab.liveQueryMessages = [{ severity: "NOTICE", message: "current notice" }];
    await nextTick();
    expect(state.view).toBe("result");
    expect(messagesButton().getAttribute("aria-label")).toBe("tabs.messages (2)");
    expect(queryExecutionLog).not.toHaveBeenCalled();

    messagesButton().click();
    await nextTick();
    expect(queryExecutionLog).toHaveBeenCalledTimes(1);
    const contents = () => host.querySelector("[data-native-clipboard]")!.textContent!;
    expect(contents()).toContain(items[total - 1]!.sql);
    expect(contents()).toContain("Affected rows: 2");
    expect(contents()).toContain("current notice");
    tab.liveQueryMessages.push({ severity: "NOTICE", message: "next notice" });
    await nextTick();
    expect(contents()).toContain("next notice");
    expect(queryExecutionLog).toHaveBeenCalledTimes(1);

    state.view = "summary";
    await nextTick();
    Object.assign(tab.batchSqlExecution!.items[total - 1]!, { status: "success", affectedRows: 7, executionTimeMs: 8 });
    await nextTick();
    expect(queryExecutionLog).toHaveBeenCalledTimes(1);
    state.view = "messages";
    await nextTick();
    expect(queryExecutionLog).toHaveBeenCalledTimes(2);
    expect(contents()).toContain(`${items[total - 1]!.sql}\n> Affected rows: 7\n> Time: 8 ms`);
    expect(contents().match(/UPDATE device SET/g)).toHaveLength(total);
    host.querySelector<HTMLButtonElement>("[data-native-clipboard] button")!.click();
    await nextTick();
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    const copied = vi.mocked(copyToClipboard).mock.calls[0]![0];
    expect(copied.match(/UPDATE device SET/g)).toHaveLength(total);
    expect(copied).toContain(`${items[total - 1]!.sql}\n> Affected rows: 7\n> Time: 8 ms`);
    expect(copied).toContain("[NOTICE] next notice");
  });

  it.each(["mongodb", "redis", "neo4j"] as const)("preserves %s command messages without adding SQL execution logs", async (databaseType) => {
    const { host, state } = await mountResults([{ ...results[0], messages: [{ severity: "INFO", message: "command output" }] }], 0, {}, databaseType);
    state.view = "messages";
    await nextTick();
    const text = host.querySelector("[data-native-clipboard]")!.textContent!;
    expect(text).toContain("command output");
    expect(text).not.toContain(statements[0]);
  });

  it("does not add execution logs to automatic table browsing", async () => {
    const { host, state } = await mountResults(results, 0, { mode: "data" }, "mysql");
    state.view = "messages";
    await nextTick();
    expect(host.querySelector("[data-native-clipboard]")).toBeNull();
  });
});
