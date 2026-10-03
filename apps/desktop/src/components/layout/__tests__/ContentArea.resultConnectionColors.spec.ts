// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryTab } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/composables/useToolbarOverflow", async () => {
  const { ref } = await import("vue");
  return { useToolbarOverflow: () => ({ tier: ref(0) }) };
});
vi.mock("@/lib/tabs/tabResultCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tabs/tabResultCache")>()),
  writeTabResultSnapshot: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/components/grid/DataGrid.vue", () => ({ __esModule: true, default: { render: () => h("div", { "data-test": "grid" }) } }));
import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  window.localStorage?.clear();
});

async function mountResults(withRuns = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [
    { id: "test", name: "Test", db_type: "sqlite", color: "#22c55e" },
    { id: "production", name: "Production", db_type: "sqlite", color: "#ef4444" },
  ];
  const result: QueryResult = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
  const tab = reactive<QueryTab>({
    id: "query",
    title: "Query",
    connectionId: "test",
    database: "app",
    mode: "query",
    sql: "SELECT 1",
    isExecuting: false,
    result,
    results: [result],
    activeResultRunId: withRuns ? "test-run" : undefined,
    resultRuns: withRuns
      ? [
          { id: "test-run", connectionId: "test", title: "Test result", customTitle: true, sequence: 1, sql: "SELECT 1", createdAt: 1, result, results: [result] },
          { id: "production-run", title: "Production result", customTitle: true, sequence: 2, sql: "SELECT 1", createdAt: 2, result, results: [result], multiDbExecution: { kind: "multi-db", batchId: "batch", target: { connectionId: "production", database: "app" }, status: "success" } },
        ]
      : undefined,
  });
  useQueryStore().tabs.push(tab);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(ContentArea, {
        activeTab: tab,
        activeConnection: connections.getConfig(tab.connectionId),
        activeOutputView: "result",
        executableSql: "",
        formatSqlRequest: null,
        compressSqlRequest: null,
        selectedSql: "",
        cursorPos: 0,
        resultOnly: true,
        blockDangerousRedisCommands: false,
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => app.unmount());
  await nextTick();
  await nextTick();
  return { host, tab, connections, settings: useSettingsStore() };
}

describe("query result connection colors", () => {
  it("captures the source connection when retaining an ordinary query result", async () => {
    const { tab } = await mountResults(false);
    useQueryStore().toggleResultAutoSave(tab.id);
    expect(tab.resultRuns?.[0]?.connectionId).toBe("test");
    tab.connectionId = "production";
    await nextTick();
    expect(tab.resultRuns?.[0]?.connectionId).toBe("test");
  });

  it("colors each run from its source and keeps the selected result color after changing the editor connection", async () => {
    const { host, tab, connections } = await mountResults();
    const markers = [...host.querySelectorAll<HTMLElement>("[data-result-run-tab] [data-result-connection-color]")];
    expect(markers.map((marker) => marker.style.backgroundColor)).toEqual(["#22c55e", "#ef4444"]);
    const surface = host.querySelector<HTMLElement>("[data-query-result-surface]")!;
    expect(surface.style.borderColor).toBe("#22c55e");
    tab.connectionId = "production";
    await nextTick();
    expect(surface.style.borderColor).toBe("#22c55e");
    tab.activeResultRunId = "production-run";
    await nextTick();
    expect(surface.style.borderColor).toBe("#ef4444");
    connections.connections[1]!.color = "#3b82f6";
    await nextTick();
    expect(surface.style.borderColor).toBe("#3b82f6");
    connections.connections[1]!.color = "";
    await nextTick();
    expect(surface.style.borderColor).toBe("");
  });

  it("colors ordinary result sets without retained runs and removes markers for an uncolored connection", async () => {
    const { host, connections } = await mountResults(false);
    expect(host.querySelector<HTMLElement>(".result-set-scroll [data-result-connection-color]")?.style.backgroundColor).toBe("#22c55e");
    connections.connections[0]!.color = "";
    await nextTick();
    expect(host.querySelector("[data-result-connection-color]")).toBeNull();
    expect(host.querySelector<HTMLElement>("[data-query-result-surface]")!.style.borderColor).toBe("");
  });

  it("shows the selected source color in list mode", async () => {
    const { host, tab, settings } = await mountResults();
    settings.editorSettings.resultRunDisplayMode = "list";
    tab.activeResultRunId = "production-run";
    await nextTick();
    expect(host.querySelector<HTMLElement>("[data-query-result-surface] [data-result-connection-color]")?.style.backgroundColor).toBe("#ef4444");
  });
});
