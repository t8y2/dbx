// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BatchSqlExecution, QueryResult, QueryTab, TabOutputView } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/transfer/QueryResultTransferDialog.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ __esModule: true, default: { render: () => h("div", { "data-test": "data-grid" }) } }));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  window.localStorage?.clear();
});

function batch(executionId: string, total: number, finishedAt?: number): BatchSqlExecution {
  return {
    executionId,
    submittedSql: "SELECT 1; SELECT 2;",
    editorFingerprint: "fp",
    sourceOffset: 0,
    completed: 0,
    total,
    startedAt: Date.now(),
    finishedAt,
    items: Array.from({ length: total }, (_, statementIndex) => ({ statementIndex, sql: `SELECT ${statementIndex + 1}`, from: 0, to: 0, status: statementIndex === 0 ? "running" : "pending" })),
  };
}

async function mountTab(options: { batch?: BatchSqlExecution; isExecuting?: boolean; results?: QueryResult[] }) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "mysql", name: "MySQL", db_type: "mysql" as const, host: "localhost", port: 3306, username: "", password: "" };
  useConnectionStore().connections = [connection];
  const results = options.results ?? [];
  const tab = reactive<QueryTab>({
    id: "query",
    title: "Query",
    connectionId: connection.id,
    database: "app",
    mode: "query",
    sql: "SELECT 1; SELECT 2;",
    isExecuting: options.isExecuting ?? true,
    results,
    result: results[0],
    activeResultIndex: 0,
    batchSqlExecution: options.batch,
  });
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
          formatSqlRequest: null,
          compressSqlRequest: null,
          selectedSql: "",
          cursorPos: 0,
          resultOnly: true,
          blockDangerousRedisCommands: false,
          "onUpdate:activeOutputView": (_tabId: string, view: string) => {
            state.view = view as TabOutputView;
          },
        }),
    }),
  );
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: { tabs: { resultN: "Result {n}", allResults: "All results ({count})" } } }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => app.unmount());
  await nextTick();
  await nextTick();
  return { host, state, tab };
}

describe("batch execution output view", () => {
  it("opens the summary while a multi-statement run is in progress", async () => {
    const { state, tab } = await mountTab({ batch: batch("run-1", 3) });

    expect(state.view).toBe("summary");
    expect(useQueryStore().tabs.find((candidate) => candidate.id === tab.id)?.uiState?.batchSummaryExecutionId).toBe("run-1");
  });

  it("keeps the view the user picks during that run", async () => {
    const { state, tab } = await mountTab({ batch: batch("run-1", 3) });
    expect(state.view).toBe("summary");

    state.view = "result";
    await nextTick();
    await nextTick();

    expect(state.view).toBe("result");
    expect(useQueryStore().tabs.find((candidate) => candidate.id === tab.id)?.uiState?.batchSummaryExecutionId).toBe("run-1");
  });

  it("opens the summary again for the next run", async () => {
    const { state, tab } = await mountTab({ batch: batch("run-1", 3) });
    state.view = "result";
    await nextTick();

    tab.batchSqlExecution = batch("run-2", 2);
    await nextTick();
    await nextTick();

    expect(state.view).toBe("summary");
    expect(useQueryStore().tabs.find((candidate) => candidate.id === tab.id)?.uiState?.batchSummaryExecutionId).toBe("run-2");
  });

  it("leaves a single-statement execution on its result grid", async () => {
    const { state } = await mountTab({ batch: batch("run-1", 1), results: [{ columns: ["a"], rows: [[1]], affected_rows: 1, execution_time_ms: 1 }] });

    expect(state.view).toBe("result");
  });

  it("does not redirect a run that already finished", async () => {
    const { state } = await mountTab({ batch: batch("run-1", 2, Date.now()), isExecuting: false, results: [{ columns: ["a"], rows: [[1]], affected_rows: 1, execution_time_ms: 1 }] });

    expect(state.view).toBe("result");
  });
});
