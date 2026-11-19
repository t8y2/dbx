// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, expect, it, vi } from "vitest";
import type { QueryResult, QueryTab } from "@/types/database";

const mocks = vi.hoisted(() => ({ sheets: vi.fn(), selected: vi.fn() }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/transfer/QueryResultTransferDialog.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: defineComponent({
    props: ["allExportResults"],
    setup(props, { expose }) {
      expose({ exportResultSheetsXlsx: mocks.selected });
      return () => {
        mocks.sheets(props.allExportResults);
        return h("div");
      };
    },
  }),
}));
vi.mock("@/components/layout/ResultSetNavigator.vue", () => ({
  default: defineComponent({
    props: ["items"],
    emits: ["export-xlsx"],
    setup:
      (props, { emit }) =>
      () =>
        h("button", { "data-test": "selected-export", onClick: () => emit("export-xlsx", [props.items[1]]) }, "Export selected"),
  }),
}));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  document.body.replaceChildren();
  window.localStorage?.clear();
  vi.clearAllMocks();
});

it("binds all and selected workbook sheets to each original result rather than the active result", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "oracle-1", name: "Oracle", db_type: "oracle" as const, host: "localhost", port: 1521, username: "test", password: "" };
  useConnectionStore().connections = [connection];
  const result = (id: number): QueryResult => ({ columns: ["ID", "BODY"], rows: [[id, "preview"]], affected_rows: 0, execution_time_ms: 1, sourceStatement: `SELECT * FROM T${id}` });
  const tab = reactive<QueryTab>({ id: "source-tab", title: "Query", connectionId: connection.id, database: "APP", mode: "query", sql: "SELECT * FROM T1; SELECT * FROM T2", isExecuting: false, results: [result(1), result(2)], activeResultIndex: 0 });
  tab.result = tab.results![0];
  const store = useQueryStore();
  store.tabs.push(tab);
  const capture = vi.spyOn(store, "captureResultLegacyValuesForExport").mockReturnValue(undefined);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(ContentArea, { activeTab: tab, activeConnection: connection, activeOutputView: "result", executableSql: "", formatSqlRequest: null, compressSqlRequest: null, selectedSql: "", cursorPos: 0, resultOnly: true, blockDangerousRedisCommands: false }) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  unmount = () => app.unmount();
  await vi.waitFor(() => expect(mocks.sheets).toHaveBeenCalled());
  const sheets = mocks.sheets.mock.lastCall![0];
  expect(sheets).toHaveLength(2);
  expect(capture).not.toHaveBeenCalled();
  sheets[0].captureSourceValues();
  sheets[1].captureSourceValues();
  expect(capture.mock.calls).toEqual([
    ["source-tab", tab.results![0]],
    ["source-tab", tab.results![1]],
  ]);
  capture.mockClear();
  host.querySelector<HTMLButtonElement>("[data-test=selected-export]")!.click();
  await nextTick();
  expect(mocks.selected).toHaveBeenCalledOnce();
  const selected = mocks.selected.mock.calls[0]![0];
  expect(selected).toHaveLength(1);
  expect(selected[0].result).toBe(tab.results![1]);
  selected[0].captureSourceValues();
  expect(capture).toHaveBeenCalledExactlyOnceWith("source-tab", tab.results![1]);
});
