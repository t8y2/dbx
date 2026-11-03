// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryTab, TabOutputView } from "@/types/database";

const calls = vi.hoisted(() => ({ grid: vi.fn(), editor: vi.fn() }));
vi.mock("@/components/grid/DataGrid.vue", async () => {
  const { defineComponent, h, ref } = await import("vue");
  return {
    __esModule: true,
    default: defineComponent({
      setup(_, { expose }) {
        const root = ref<HTMLElement>();
        expose({
          focusGrid: () => {
            calls.grid();
            root.value?.focus();
            return true;
          },
        });
        return () => h("div", { ref: root, tabindex: 0, "data-test": "grid" });
      },
    }),
  };
});
vi.mock("@/components/editor/QueryEditor.vue", () => ({
  __esModule: true,
  default: {
    methods: {
      focusEditor() {
        calls.editor();
        return true;
      },
    },
    render: () => h("div"),
  },
}));
import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  localStorage.clear();
  vi.clearAllMocks();
});
async function mountSurface(options: { resultOnly?: boolean; view?: TabOutputView; result?: QueryTab["result"] } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "pg", name: "PostgreSQL", db_type: "postgres" as const, host: "localhost", port: 5432, username: "", password: "" };
  useConnectionStore().connections = [connection];
  const state = reactive({ view: options.view ?? "result" });
  const tab = reactive<QueryTab>({ id: "query", title: "Query", connectionId: connection.id, database: "app", mode: "query", sql: "SELECT 1", isExecuting: false, result: options.result ?? { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 } });
  useQueryStore().tabs.push(tab);
  const surface = ref<InstanceType<typeof ContentArea>>();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ContentArea, {
          ref: surface,
          activeTab: tab,
          activeConnection: connection,
          activeOutputView: state.view,
          executableSql: tab.sql,
          formatSqlRequest: null,
          compressSqlRequest: null,
          selectedSql: "",
          cursorPos: 0,
          resultOnly: options.resultOnly ?? true,
          blockDangerousRedisCommands: false,
          "onUpdate:activeOutputView": (_id: string, view: TabOutputView) => {
            state.view = view;
          },
        }),
    }),
  );
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await nextTick();
  return { host, surface: surface.value!, tab, state };
}

describe("query surface focus handoff", () => {
  it("switches from Messages and waits for the asynchronous grid to mount", async () => {
    const { host, surface, state } = await mountSurface({ view: "messages" });
    expect(host.querySelector('[data-test="grid"]')).toBeNull();
    expect(surface.focusResultGrid()).toBe(true);
    await vi.waitFor(() => expect(calls.grid).toHaveBeenCalledOnce());
    expect(state.view).toBe("result");
    expect(document.activeElement).toBe(host.querySelector('[data-test="grid"]'));
  });
  it("does not focus a replacement result that arrives during the handoff", async () => {
    const { surface, tab } = await mountSurface({ view: "messages" });
    surface.focusResultGrid();
    tab.result = { ...tab.result!, rows: [[2]] };
    await nextTick();
    await nextTick();
    expect(calls.grid).not.toHaveBeenCalled();
  });
  it("cancels a pending focus request when returning to the editor", async () => {
    const { surface } = await mountSurface({ view: "messages" });
    surface.focusResultGrid();
    surface.cancelResultGridFocus();
    await nextTick();
    await nextTick();
    expect(calls.grid).not.toHaveBeenCalled();
  });
  it("does not steal focus from a control used while the grid is mounting", async () => {
    const { surface } = await mountSurface({ view: "messages" });
    surface.focusResultGrid();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await nextTick();
    await nextTick();
    expect(calls.grid).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
  it.each([
    { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 },
    { columns: ["Message"], rows: [["done"]], affected_rows: 0, execution_time_ms: 1, server_message: true },
  ])("leaves update-only and message output untouched", async (result) => {
    const { surface, state } = await mountSurface({ result, view: "messages" });
    expect(surface.focusResultGrid()).toBe(false);
    await nextTick();
    expect(state.view).toBe("messages");
    expect(calls.grid).not.toHaveBeenCalled();
  });
  it("routes editor focus to the editor and ignores the result-only surface", async () => {
    const editorSurface = await mountSurface({ resultOnly: false });
    await vi.waitFor(() => expect(editorSurface.surface.focusSqlEditor()).toBe(true));
    expect(calls.editor).toHaveBeenCalledOnce();
    const resultSurface = await mountSurface();
    expect(resultSurface.surface.focusSqlEditor()).toBe(false);
    expect(calls.editor).toHaveBeenCalledOnce();
  });
});
