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
vi.mock("@/components/grid/DataGrid.vue", () => ({ __esModule: true, default: { render: () => null } }));
import ContentArea from "../ContentArea.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  window.localStorage?.clear();
});

async function mountResults(enabled: boolean, pinned = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.editorSettings.pinResultOnTabClick = enabled;
  const result: QueryResult = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
  const tab = reactive<QueryTab>({
    id: "query",
    title: "Query",
    connectionId: "sqlite",
    database: "app",
    mode: "query",
    sql: "SELECT 1",
    isExecuting: false,
    result,
    results: [result],
    activeResultRunId: "first",
    resultRuns: [
      { id: "first", title: "First", sequence: 1, sql: "SELECT 1", createdAt: 1, result, results: [result] },
      { id: "second", title: "Second", sequence: 2, sql: "SELECT 1", createdAt: 2, result, results: [result], pinned },
    ],
  });
  const queries = useQueryStore();
  queries.tabs.push(tab);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(ContentArea, {
        activeTab: tab,
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
  return { host, tab, settings, queries };
}

describe("result-tab click pinning", () => {
  it.each([true, false])("selects the clicked run and only pins when enabled=%s", async (enabled) => {
    const { host, tab } = await mountResults(enabled);
    host.querySelectorAll<HTMLButtonElement>("[data-result-run-tab]")[1]!.click();
    await vi.waitFor(() => expect(tab.activeResultRunId).toBe("second"));
    for (let index = 0; index < 10; index++) await nextTick();
    expect(tab.resultRuns![1]!.pinned === true).toBe(enabled);
  });

  it("does not unpin retained results when disabled and still permits explicit pinning", async () => {
    const { host, tab, queries } = await mountResults(false, true);
    host.querySelectorAll<HTMLButtonElement>("[data-result-run-tab]")[1]!.click();
    await vi.waitFor(() => expect(tab.activeResultRunId).toBe("second"));
    expect(tab.resultRuns![1]!.pinned).toBe(true);
    queries.toggleResultRunPinned(tab.id, "first");
    expect(tab.resultRuns![0]!.pinned).toBe(true);
  });

  it("applies a setting change to already mounted result tabs", async () => {
    const { host, tab, settings } = await mountResults(false);
    settings.editorSettings.pinResultOnTabClick = true;
    await nextTick();
    host.querySelectorAll<HTMLButtonElement>("[data-result-run-tab]")[1]!.click();
    await vi.waitFor(() => expect(tab.resultRuns![1]!.pinned).toBe(true));
  });
});
