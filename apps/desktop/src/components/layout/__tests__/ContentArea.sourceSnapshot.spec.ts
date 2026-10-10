// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { expect, it, vi } from "vitest";
import type { QueryTab } from "@/types/database";

const editor = vi.hoisted(() => ({ props: undefined as undefined | { readOnly: boolean; hideExecutionControls: boolean; modelValue: string } }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({
  __esModule: true,
  default: defineComponent({
    props: ["readOnly", "hideExecutionControls", "modelValue"],
    setup(props) {
      editor.props = props as any;
      return () => h("pre", props.modelValue);
    },
  }),
}));
vi.mock("@/components/transfer/QueryResultTransferDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ default: { render: () => null } }));
import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";

it("passes read-only and hidden execution controls to the mounted editor for a preserved source snapshot", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "ob", name: "OB", db_type: "oceanbase-oracle" as const, host: "localhost", port: 2881, username: "APP", password: "" };
  useConnectionStore().connections = [connection];
  const tab = reactive<QueryTab>({ id: "snapshot", title: "Original source", connectionId: "ob", database: "APP", mode: "query", sql: "CREATE VIEW APP.OLD AS SELECT 2 FROM DUAL", isExecuting: false, sourceSnapshot: true });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup: () => () => h(ContentArea, { activeTab: tab, activeConnection: connection, activeOutputView: "result", executableSql: tab.sql, formatSqlRequest: null, compressSqlRequest: null, selectedSql: "", cursorPos: 0, resultOnly: false, blockDangerousRedisCommands: false }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  try {
    app.mount(host);
    await vi.waitFor(() => expect(editor.props).toBeDefined());
    expect(editor.props).toMatchObject({ readOnly: true, hideExecutionControls: true, modelValue: tab.sql });
    expect(host.textContent).toContain(tab.sql);
    tab.sourceSnapshot = false;
    await nextTick();
    expect(editor.props).toMatchObject({ readOnly: false, hideExecutionControls: false });
  } finally {
    app.unmount();
    host.remove();
    window.localStorage?.clear();
  }
});
