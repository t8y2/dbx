// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryTab } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGridColumnLayoutPopover.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: defineComponent({
    name: "DataGridStub",
    setup(_, { slots }) {
      return () => h("div", { "data-test": "data-grid" }, slots["result-toolbar-actions"]?.({ compact: false }));
    },
  }),
}));
vi.mock("@/components/layout/QueryResultToolbarActions.vue", () => ({
  default: defineComponent({
    name: "QueryResultToolbarActionsStub",
    emits: ["open-result-view"],
    setup(_, { emit }) {
      return () =>
        h(
          "button",
          {
            type: "button",
            "data-test": "open-result-view",
            onClick: () => emit("open-result-view", "com.example.chart", "result.chart", "Chart"),
          },
          "Open result view",
        );
    },
  }),
}));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const connection = {
  id: "conn-1",
  name: "Test MySQL",
  db_type: "mysql",
  driver_profile: "mysql",
  host: "localhost",
  port: 3306,
  username: "",
  password: "",
};

function result(sourceStatement?: string): QueryResult {
  return {
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 1,
    ...(sourceStatement === undefined ? {} : { sourceStatement }),
  };
}

function queryTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "query-1",
    title: "Query",
    connectionId: connection.id,
    database: "app",
    mode: "query",
    sql: "SELECT * FROM a;\nSELECT * FROM b;",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    ...overrides,
  } as QueryTab;
}

const mountedApps: Array<{ app: App<Element>; host: HTMLDivElement }> = [];

async function mountContentArea(tab: QueryTab) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connectionStore = useConnectionStore();
  connectionStore.connections = [connection];
  const queryStore = useQueryStore();
  const openPluginWorkbench = vi.spyOn(queryStore, "openPluginWorkbench");
  const state = reactive({ activeTab: tab });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = defineComponent({
    setup: () => () =>
      h(ContentArea, {
        activeTab: state.activeTab,
        activeConnection: connectionStore.getConfig(connection.id),
        activeOutputView: "result",
        executableSql: state.activeTab.sql,
        formatSqlRequest: null,
        compressSqlRequest: null,
        selectedSql: "",
        cursorPos: 0,
        blockDangerousRedisCommands: false,
        resultOnly: true,
      }),
  });
  const app = createApp(root);
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ app, host });
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const button = host.querySelector<HTMLButtonElement>('[data-test="open-result-view"]');
  expect(button).not.toBeNull();
  button!.click();
  await nextTick();
  return openPluginWorkbench;
}

describe("ContentArea result-view context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    for (const { app, host } of mountedApps.splice(0)) {
      app.unmount();
      host.remove();
    }
  });

  it("uses the active result source statement instead of the whole editor SQL", async () => {
    const openPluginWorkbench = await mountContentArea(
      queryTab({
        resultBaseSql: "SELECT * FROM a;\nSELECT * FROM b;",
        results: [result("SELECT * FROM a;"), result("SELECT * FROM b;")],
        activeResultIndex: 1,
        result: result("SELECT * FROM b;"),
      }),
    );

    expect(openPluginWorkbench).toHaveBeenCalledWith(
      "com.example.chart",
      "result.chart",
      expect.objectContaining({
        context: expect.objectContaining({ sql: "SELECT * FROM b;" }),
      }),
    );
    expect(openPluginWorkbench.mock.calls[0]?.[2]).not.toEqual(expect.objectContaining({ context: expect.objectContaining({ sql: "SELECT * FROM a;\nSELECT * FROM b;" }) }));
  });

  it("uses lastExecutedSql when the editor SQL is empty", async () => {
    const openPluginWorkbench = await mountContentArea(
      queryTab({
        sql: "",
        lastExecutedSql: "SELECT * FROM users",
        result: result(),
      }),
    );

    expect(openPluginWorkbench.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        context: expect.objectContaining({ sql: "SELECT * FROM users" }),
      }),
    );
  });

  it("keeps the existing fallback for legacy results without sourceStatement", async () => {
    const openPluginWorkbench = await mountContentArea(
      queryTab({
        resultBaseSql: "SELECT * FROM users",
        result: result(),
      }),
    );

    expect(openPluginWorkbench.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        context: expect.objectContaining({ sql: "SELECT * FROM users" }),
      }),
    );
  });
});
