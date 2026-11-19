// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryTab } from "@/types/database";

const editorViewport = vi.hoisted(() => ({ begin: vi.fn(), complete: vi.fn() }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({
  __esModule: true,
  default: defineComponent({
    setup(_, { expose }) {
      expose({ beginExecutionViewportTracking: editorViewport.begin, scrollCursorIntoView: editorViewport.complete });
      return () => h("div");
    },
  }),
}));
vi.mock("@/components/transfer/QueryResultTransferDialog.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: defineComponent({
    render: () => h("div", { "data-test": "data-grid" }, "DataGrid Mock"),
  }),
}));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  window.localStorage?.clear();
  vi.clearAllMocks();
});

async function mountContentArea(options: { result?: QueryResult; isExecuting?: boolean; queryExecutionStartedAt?: number; resultOnly?: boolean }) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "mysql-1", name: "MySQL", db_type: "mysql" as const, host: "localhost", port: 3306, username: "root", password: "" };
  useConnectionStore().connections = [connection];
  const tab = reactive<QueryTab>({
    id: "query-tab-1",
    title: "Query 1",
    connectionId: connection.id,
    database: "app",
    mode: "query",
    sql: "SELECT 1",
    isExecuting: options.isExecuting ?? false,
    queryExecutionStartedAt: options.queryExecutionStartedAt,
    result: options.result,
    activeResultIndex: 0,
  });
  useQueryStore().tabs.push(tab);

  const state = reactive({ view: "result" as "result" | "messages" });
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
          formatSqlRequest: null,
          compressSqlRequest: null,
          selectedSql: "",
          cursorPos: 0,
          resultOnly: options.resultOnly ?? true,
          keywordCaseRequest: null,
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
      locale: "zh-CN",
      messages: {
        "zh-CN": {
          common: { loading: "正在执行", stopping: "停止中" },
          toolbar: { stopQuery: "停止执行" },
          grid: { cachedResultUnavailable: "结果不可用", reexecuteQuery: "重新执行" },
          editor: { pressToExecute: "按快捷键执行", pressToSaveSql: "按快捷键保存" },
          tabs: { resultN: "结果 {n}", removeRun: "Close run {n}" },
        },
      },
      missingWarn: false,
      fallbackWarn: false,
    }),
  );
  app.mount(host);
  cleanups.push(() => app.unmount());
  await nextTick();
  await nextTick();
  if (options.resultOnly === false) await new Promise((resolve) => setTimeout(resolve, 50));
  return { host, state, tab };
}

describe("ContentArea query loading state on error re-execute", () => {
  const noRowResult: QueryResult = {
    columns: [],
    rows: [],
    affected_rows: 0,
    execution_time_ms: 1,
  };
  const errorResult: QueryResult = {
    columns: ["Error"],
    execution_error: true,
    rows: [["数据库操作已取消 (阶段: cancel)"]],
    affected_rows: 0,
    execution_time_ms: 0,
  };

  it("shows QueryLoadingState with elapsed time when re-executing after an error result", async () => {
    const startedAt = Date.now() - 1500;
    const { host, tab } = await mountContentArea({
      result: errorResult,
      isExecuting: true,
      queryExecutionStartedAt: startedAt,
    });

    // When isExecuting is true and result is an error result, DataGrid must not be shown;
    // QueryLoadingState must be displayed with the live elapsed duration and cancel button.
    expect(host.querySelector('[data-test="data-grid"]')).toBeNull();
    expect(host.textContent).toContain("正在执行");
    expect(host.textContent).toMatch(/· \d+\.\d+s/);
    expect(host.textContent).toContain("停止执行");

    // Once execution completes with a success result, DataGrid replaces the loading state.
    tab.isExecuting = false;
    tab.queryExecutionStartedAt = undefined;
    tab.result = {
      columns: ["id"],
      rows: [[1]],
      affected_rows: 1,
      execution_time_ms: 12,
      client_request_wait_ms: 12,
    };
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    expect(host.querySelector('[data-test="data-grid"]')).not.toBeNull();
    expect(host.textContent).not.toContain("正在执行");
  });

  it("shows QueryLoadingState with elapsed time for the next query after a no-row result", async () => {
    const startedAt = Date.now() - 1500;
    // A statement such as `set statement_timeout to '100s'` has no columns, so
    // the retained result cannot mount DataGrid. The next query still needs the
    // live elapsed time and stop action while it runs (issue #13508).
    const { host, tab } = await mountContentArea({
      result: noRowResult,
      isExecuting: true,
      queryExecutionStartedAt: startedAt,
    });

    expect(host.querySelector('[data-test="data-grid"]')).toBeNull();
    expect(host.textContent).toContain("正在执行");
    expect(host.textContent).toMatch(/· \d+\.\d+s/);
    expect(host.textContent).toContain("停止执行");

    // Once the next query returns rows, the result grid takes over again.
    tab.isExecuting = false;
    tab.queryExecutionStartedAt = undefined;
    tab.result = {
      columns: ["pg_sleep"],
      rows: [[""]],
      affected_rows: 0,
      execution_time_ms: 12,
      client_request_wait_ms: 12,
    };
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    expect(host.querySelector('[data-test="data-grid"]')).not.toBeNull();
    expect(host.textContent).not.toContain("正在执行");
  });

  it("shows DataGrid when tab has an error result and is not executing", async () => {
    const { host } = await mountContentArea({
      result: errorResult,
      isExecuting: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();
    expect(host.querySelector('[data-test="data-grid"]')).not.toBeNull();
    expect(host.textContent).not.toContain("正在执行");
  });

  it.each(["normal", "preparation"])("locates a new error after %s execution completes", async (mode) => {
    const { tab } = await mountContentArea({ resultOnly: false });
    tab.sql = "SELECT * FROM missing";
    tab.isExecuting = true;
    tab.executionId = mode === "preparation" ? "preparation" : "execution";
    if (mode === "preparation") {
      await nextTick();
      tab.executionId = "execution";
    }
    tab.result = { ...errorResult, sourceExecutionId: "execution", rows: [["ORA-00942: table or view does not exist error occur at position: 14"]], sourceStatement: tab.sql, sourceFrom: 0, sourceTo: tab.sql.length };
    tab.isExecuting = false;
    tab.executionId = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editorViewport.begin).toHaveBeenCalledTimes(1);
    expect(editorViewport.complete).toHaveBeenCalledWith(14);
  });

  it("scrolls the cursor into view for a completion observed without a tracked start", async () => {
    // The surface mounts while the tab already executes, so no rising edge is
    // observed and beginExecutionViewportTracking never runs for this execution.
    const { tab } = await mountContentArea({ isExecuting: true, resultOnly: false });
    expect(editorViewport.begin).not.toHaveBeenCalled();

    tab.result = { columns: ["id"], rows: [[1]], affected_rows: 1, execution_time_ms: 12 };
    tab.isExecuting = false;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(editorViewport.complete).toHaveBeenCalledTimes(1);
    expect(editorViewport.complete).toHaveBeenCalledWith();
  });

  it.each(["cancel", "edit", "switch", "new-execution"])("does not auto-locate after %s", async (reason) => {
    const { tab } = await mountContentArea({ resultOnly: false });
    tab.sql = "SELECT * FROM missing";
    tab.isExecuting = true;
    tab.executionId = "execution";
    if (reason === "cancel") {
      tab.cancelRequestCount = 1;
      tab.isCancelling = true;
    }
    if (reason === "switch") window.dispatchEvent(new CustomEvent("dbx:before-tab-switch", { detail: { fromTabId: tab.id, tabId: tab.id } }));
    tab.result = { ...errorResult, sourceExecutionId: "execution", rows: [["ORA-00942: table or view does not exist error occur at position: 14"]], sourceStatement: tab.sql, sourceFrom: 0, sourceTo: tab.sql.length };
    tab.isExecuting = false;
    tab.isCancelling = false;
    tab.executionId = undefined;
    if (reason === "edit") tab.sql += " ";
    if (reason === "new-execution") {
      tab.isExecuting = true;
      tab.executionId = "next";
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editorViewport.complete).not.toHaveBeenCalled();
  });

  it("does not auto-locate an old error restored during failed preparation", async () => {
    const { tab } = await mountContentArea({ resultOnly: false });
    tab.sql = "SELECT * FROM missing";
    tab.isExecuting = true;
    tab.executionId = "preparation";
    await nextTick();
    tab.result = { ...errorResult, rows: [["ORA-00942 error occur at position: 14"]], sourceStatement: tab.sql, sourceFrom: 0, sourceTo: tab.sql.length };
    tab.isExecuting = false;
    tab.executionId = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editorViewport.complete).not.toHaveBeenCalled();
  });

  it.each(["round-trip", "close"])("keeps automatic focus revoked after a result run %s", async (action) => {
    const { tab, host } = await mountContentArea({ resultOnly: false });
    tab.sql = "SELECT * FROM missing";
    tab.resultRuns = [
      { id: "first", title: "First", sequence: 1, createdAt: 1, sql: tab.sql, result: errorResult },
      { id: "second", title: "Second", sequence: 2, createdAt: 2, sql: tab.sql, result: errorResult },
    ];
    tab.activeResultRunId = "first";
    await nextTick();
    tab.isExecuting = true;
    tab.executionId = "execution";
    if (action === "round-trip") {
      (host.querySelectorAll("[data-result-run-tab]")[1] as HTMLButtonElement).click();
      await vi.waitFor(() => expect(tab.activeResultRunId).toBe("second"));
      (host.querySelectorAll("[data-result-run-tab]")[0] as HTMLButtonElement).click();
      await vi.waitFor(() => expect(tab.activeResultRunId).toBe("first"));
    } else {
      (host.querySelector('[aria-label="Close run 1"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(tab.resultRuns?.some((run) => run.id === "first")).toBe(false));
    }
    tab.result = { ...errorResult, sourceExecutionId: "execution", rows: [["ORA-00942 error occur at position: 14"]], sourceStatement: tab.sql, sourceFrom: 0, sourceTo: tab.sql.length };
    tab.isExecuting = false;
    tab.executionId = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editorViewport.complete).not.toHaveBeenCalled();
  });
});
