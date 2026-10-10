// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResultRun, QueryTab } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: {
    setup(_props: unknown, { expose }: { expose: (value: unknown) => void }) {
      expose({});
      return () => null;
    },
  },
}));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const cleanups: Array<() => void> = [];
beforeEach(() => {
  window.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  window.localStorage?.clear();
  useQueryStore().tabs = [];
});

async function mountRuns(runs: QueryResultRun[], pinResultTabOnClick = true, tabId = "query-tab-1") {
  const pinia = createPinia();
  setActivePinia(pinia);

  const settingsStore = useSettingsStore();
  settingsStore.editorSettings.resultRunDisplayMode = "tabs";
  settingsStore.editorSettings.pinResultTabOnClick = pinResultTabOnClick;

  const connection = { id: "test-conn", name: "Test Conn", db_type: "mysql" as const, host: "localhost", port: 3306, username: "", password: "" };
  useConnectionStore().connections = [connection];

  const queryStore = useQueryStore();
  const tab: QueryTab = {
    id: tabId,
    title: "Query",
    connectionId: connection.id,
    database: "app",
    mode: "query",
    sql: "SELECT 1",
    isExecuting: false,
    results: runs[0]?.result ? [runs[0].result] : [],
    result: runs[0]?.result,
    activeResultIndex: 0,
    resultRuns: runs.map((run) => ({ ...run })),
  };
  queryStore.tabs = [tab];

  const state = reactive({ view: "result" as const });
  const host = document.createElement("div");
  document.body.appendChild(host);

  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ContentArea, {
          activeTab: queryStore.tabs[0]!,
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
            state.view = view as typeof state.view;
          },
        }),
    }),
  );
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          tabs: {
            resultRuns: "Result runs",
            runN: "Run {n}",
            removeRun: "Remove run {n}",
            resultN: "Result {n}",
            allResults: "All results ({count})",
            pinResultRun: "Pin result tab",
            unpinResultRun: "Unpin result tab",
            unpinAllResultRuns: "Unpin all result tabs",
            renameResultRun: "Rename result tab",
            closeOtherResultRuns: "Close other result tabs",
            closeResultRunsToLeft: "Close result tabs to the left",
            closeResultRunsToRight: "Close result tabs to the right",
          },
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

  return { host, queryStore, settingsStore, tab: queryStore.tabs[0]! };
}

describe("pinResultTabOnClick setting in ContentArea", () => {
  const createTestRuns = (): QueryResultRun[] => [
    {
      id: "run-1",
      title: "Query 1",
      sequence: 1,
      sql: "SELECT 1",
      createdAt: 1000,
      activeResultIndex: 0,
      result: { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      pinned: true,
    },
    {
      id: "run-2",
      title: "Query 2",
      sequence: 2,
      sql: "SELECT 2",
      createdAt: 2000,
      activeResultIndex: 0,
      result: { columns: ["id"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
      pinned: false,
    },
  ];

  it("automatically pins the result run tab when clicked if pinResultTabOnClick is true", async () => {
    const runs = createTestRuns();
    const { host, tab } = await mountRuns(runs, true);

    const buttons = host.querySelectorAll<HTMLButtonElement>("button[data-result-run-tab]");
    expect(buttons.length).toBe(2);

    expect(tab.resultRuns?.[1]?.pinned).toBeFalsy();

    // Click on Run 2 tab
    buttons[1]!.click();

    // With pinResultTabOnClick=true, Run 2 should now be pinned
    await vi.waitFor(() => expect(tab.resultRuns?.[1]?.pinned).toBe(true));
  });

  it("does not automatically pin the result run tab when clicked if pinResultTabOnClick is false", async () => {
    const runs = createTestRuns();
    const { host, tab, queryStore } = await mountRuns(runs, false, "query-tab-2");

    const buttons = host.querySelectorAll<HTMLButtonElement>("button[data-result-run-tab]");
    expect(buttons.length).toBe(2);

    expect(tab.resultRuns?.[1]?.pinned).toBeFalsy();

    // Click on Run 2 tab
    buttons[1]!.click();
    await vi.waitFor(() => expect(tab.activeResultRunId).toBe("run-2"));

    // With pinResultTabOnClick=false, Run 2 should NOT be pinned
    expect(tab.resultRuns?.[1]?.pinned).toBeFalsy();

    // But other ways of pinning (e.g. toggleResultRunPinned via context menu) still work
    queryStore.toggleResultRunPinned(tab.id, "run-2");
    expect(tab.resultRuns?.[1]?.pinned).toBe(true);
  });
});
