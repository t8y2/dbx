// @vitest-environment happy-dom
import { createApp, defineComponent, h, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryTab } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/transfer/QueryResultTransferDialog.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGridExportMenu.vue", () => ({ __esModule: true, default: { render: () => null } }));
// The real grid owns the toolbar slot host; render it so the content-area
// action that lives inside it is actually mounted.
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: defineComponent({
    props: ["result"],
    setup(_, { slots }) {
      return () => h("div", { "data-test": "data-grid" }, slots["result-toolbar-actions"]?.({ compact: false }));
    },
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

function result(overrides: Partial<QueryResult> = {}): QueryResult {
  return { columns: ["ID", "NAME"], rows: [[1, "alice"]], affected_rows: 0, execution_time_ms: 1, ...overrides };
}

async function mountContentArea(resultValue: QueryResult, onSendResultToAi: (tabId: string) => void) {
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
    sql: "SELECT * FROM users",
    isExecuting: false,
    result: resultValue,
    activeResultIndex: 0,
  });
  useQueryStore().tabs.push(tab);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ContentArea, { activeTab: tab, activeConnection: connection, activeOutputView: "result", executableSql: "", formatSqlRequest: null, compressSqlRequest: null, selectedSql: "", cursorPos: 0, resultOnly: true, blockDangerousRedisCommands: false, onSendResultToAi }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => app.unmount());
  return host;
}

describe("ContentArea send result to AI", () => {
  it("renders the toolbar action for a tabular result and forwards the tab id", async () => {
    const sends: string[] = [];
    const host = await mountContentArea(result(), (tabId) => sends.push(tabId));

    const button = await vi.waitFor(() => {
      const element = host.querySelector<HTMLButtonElement>("[data-query-result-send-ai]");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(button.getAttribute("aria-label")).toBe("ai.sendResultToAi");

    button.click();
    expect(sends).toEqual(["query-tab-1"]);
  });

  it("hides the action for an execution-error result and for a result with no rows", async () => {
    const errorHost = await mountContentArea(result({ execution_error: true, rows: [["boom"]] }), () => {});
    await vi.waitFor(() => expect(errorHost.querySelector("[data-test=data-grid]")).not.toBeNull());
    expect(errorHost.querySelector("[data-query-result-send-ai]")).toBeNull();

    const emptyHost = await mountContentArea(result({ rows: [] }), () => {});
    await vi.waitFor(() => expect(emptyHost.querySelector("[data-test=data-grid]")).not.toBeNull());
    expect(emptyHost.querySelector("[data-query-result-send-ai]")).toBeNull();
  });
});
