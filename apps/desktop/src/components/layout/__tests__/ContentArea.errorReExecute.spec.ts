// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryTab } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
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
});

async function mountContentArea(options: { result?: QueryResult; isExecuting?: boolean; queryExecutionStartedAt?: number }) {
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
          resultOnly: true,
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
          tabs: { resultN: "结果 {n}" },
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
  return { host, state, tab };
}

describe("ContentArea query loading state on error re-execute", () => {
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
});
