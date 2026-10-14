// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryTab } from "@/types/database";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/transfer/QueryResultTransferDialog.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ default: { render: () => h("div", { "data-test": "data-grid" }) } }));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { createInlineQueryResultPortal, INLINE_QUERY_RESULT_PORTAL, type InlineQueryResultPortal } from "@/lib/editor/inlineQueryResultPortal";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  window.localStorage?.clear();
});

async function mountContentAreaWithRuns(options: { results: QueryResult[]; resultRuns?: NonNullable<QueryTab["resultRuns"]>; activeResultRunId?: string; inlineResult?: boolean; historyOnly?: boolean; closeInlineResult?: () => void; portal?: InlineQueryResultPortal }) {
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
    isExecuting: false,
    results: options.results,
    result: options.results[0],
    activeResultIndex: 0,
    resultRuns: options.resultRuns,
    activeResultRunId: options.activeResultRunId,
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
          inlineResult: options.inlineResult,
          historyOnly: options.historyOnly,
          closeInlineResult: options.closeInlineResult,
          blockDangerousRedisCommands: false,
          "onUpdate:activeOutputView": (_tabId: string, view: string) => {
            state.view = view as typeof state.view;
          },
        }),
    }),
  );
  app.use(pinia);
  if (options.portal) app.provide(INLINE_QUERY_RESULT_PORTAL, options.portal);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          tabs: {
            resultN: "Result {n}",
            runN: "Run {n}",
            resultRuns: "Result runs",
            resultSets: "Result sets",
            allResults: "All results ({count})",
            removeRun: "Remove run {n}",
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
  return { host, state, tab };
}

describe("ContentArea result run tabs layout and middle-click close", () => {
  const singleResult: QueryResult = {
    columns: ["id"],
    rows: [[1]],
    affected_rows: 1,
    execution_time_ms: 5,
  };
  const secondResult: QueryResult = {
    columns: ["name"],
    rows: [["Alice"]],
    affected_rows: 1,
    execution_time_ms: 3,
  };
  it("closes an inline result with a Run using its local callback and keeps its label at the start", async () => {
    const close = vi.fn();
    const { host } = await mountContentAreaWithRuns({
      results: [singleResult],
      resultRuns: [{ id: "run-1", title: "Run 1", sequence: 1, sql: "SELECT 1", createdAt: 1, result: singleResult, results: [singleResult] }],
      activeResultRunId: "run-1",
      inlineResult: true,
      closeInlineResult: close,
    });
    const store = useQueryStore();
    const deleteResult = vi.spyOn(store, "closeQueryResult");
    const navigator = host.querySelector("[data-result-set-tabs-region]")!;
    expect(navigator.previousElementSibling?.classList.contains("flex-1")).toBe(false);
    host.querySelector<HTMLButtonElement>('[aria-label="tabs.closeResult"]')!.click();
    await nextTick();
    expect(close).toHaveBeenCalledTimes(1);
    host.querySelector<HTMLButtonElement>('[aria-label="editor.hideResultsPane"]')!.click();
    await nextTick();
    expect(close).toHaveBeenCalledTimes(2);
    expect(deleteResult).not.toHaveBeenCalled();
  });
  it("reopens a dismissed result when its Run is explicitly selected in compact history", async () => {
    const portal = createInlineQueryResultPortal();
    const { host, tab } = await mountContentAreaWithRuns({
      results: [singleResult],
      resultRuns: [{ id: "run-1", title: "Run 1", sequence: 1, sql: "SELECT 1", createdAt: 1, result: singleResult, results: [singleResult] }],
      activeResultRunId: "run-1",
      historyOnly: true,
      portal,
    });
    portal.dismiss(tab.id, tab.result!);
    host.querySelector<HTMLButtonElement>("[data-result-run-tab]")!.click();
    await nextTick();
    await nextTick();
    await vi.waitFor(() => expect(portal.isDismissed(tab.id, tab.result!)).toBe(false));
    expect(tab.result?.rows).toEqual([[1]]);
  });

  it("hides ResultSetNavigator when resultRuns exist and active run has a single result set", async () => {
    const { host } = await mountContentAreaWithRuns({
      results: [singleResult],
      resultRuns: [
        { id: "run-1", title: "Run 1", sequence: 1, sql: "SELECT 1", createdAt: 1, result: singleResult, results: [singleResult] },
        { id: "run-2", title: "Run 2", sequence: 2, sql: "SELECT 2", createdAt: 2, result: singleResult, results: [singleResult] },
      ],
      activeResultRunId: "run-1",
    });

    const runTabsRegion = host.querySelector("[data-result-run-tabs-region]");
    expect(runTabsRegion).not.toBeNull();
    const runTabs = host.querySelectorAll("[data-result-run-tab]");
    expect(runTabs.length).toBe(2);

    // ResultSetNavigator is hidden because visibleResultItems.length <= 1
    const resultSetRegion = host.querySelector("[data-result-set-tabs-region]");
    expect(resultSetRegion).toBeNull();
  });

  it("shows ResultSetNavigator when resultRuns exist and active run has multiple result sets", async () => {
    const { host } = await mountContentAreaWithRuns({
      results: [singleResult, secondResult],
      resultRuns: [
        { id: "run-1", title: "Run 1", sequence: 1, sql: "SELECT 1; SELECT 2;", createdAt: 1, result: singleResult, results: [singleResult, secondResult] },
        { id: "run-2", title: "Run 2", sequence: 2, sql: "SELECT 3", createdAt: 2, result: singleResult, results: [singleResult] },
      ],
      activeResultRunId: "run-1",
    });

    const runTabsRegion = host.querySelector("[data-result-run-tabs-region]");
    expect(runTabsRegion).not.toBeNull();

    // ResultSetNavigator is shown because visibleResultItems.length > 1
    const resultSetRegion = host.querySelector("[data-result-set-tabs-region]");
    expect(resultSetRegion).not.toBeNull();
    expect(resultSetRegion?.classList.contains("shrink-0")).toBe(true);
    expect(resultSetRegion?.classList.contains("max-w-[50%]")).toBe(true);
  });

  it("closes result run on middle click on the result run tab", async () => {
    const { host } = await mountContentAreaWithRuns({
      results: [singleResult],
      resultRuns: [
        { id: "run-1", title: "Run 1", sequence: 1, sql: "SELECT 1", createdAt: 1, result: singleResult, results: [singleResult] },
        { id: "run-2", title: "Run 2", sequence: 2, sql: "SELECT 2", createdAt: 2, result: singleResult, results: [singleResult] },
      ],
      activeResultRunId: "run-1",
    });

    const queryStore = useQueryStore();
    const removeSpy = vi.spyOn(queryStore, "removeResultRun").mockResolvedValue(true);

    const runTabs = host.querySelectorAll<HTMLButtonElement>("[data-result-run-tab]");
    expect(runTabs.length).toBe(2);

    // Middle click on run-2 (button: 1)
    const middleClickEvent = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    runTabs[1]!.dispatchEvent(middleClickEvent);
    await nextTick();

    expect(removeSpy).toHaveBeenCalledWith("query-tab-1", "run-2");
  });
});
