// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DataGridFilterEditorView } from "@/stores/settingsStore";
import { clearDataGridSortBuilderMemoryCache } from "@/composables/useDataGridSortBuilder";
import { clearDataGridStructuredFilterStates } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";
import { dataGridConditionHistoryScopeKey } from "@/lib/dataGrid/dataGridConditionHistory";

const backendMocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(async ({ tableName, orderBy }: { tableName: string; orderBy?: string }) => `SELECT * FROM ${tableName}${orderBy ? ` ORDER BY ${orderBy}` : ""}`),
  loadEditorSettings: vi.fn().mockResolvedValue({}),
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    buildTableSelectSql: backendMocks.buildTableSelectSql,
    loadEditorSettings: backendMocks.loadEditorSettings,
    saveEditorSettings: backendMocks.saveEditorSettings,
  };
});

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    RecycleScroller: defineComponent({
      props: {
        items: {
          type: Array as PropType<unknown[]>,
          default: () => [],
        },
      },
      setup(props, { attrs, slots }) {
        return () =>
          h(
            "div",
            attrs,
            props.items.map((item) => slots.default?.({ item })),
          );
      },
    }),
  };
});

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      renderedColumnWidths: ref([120]),
      totalWidth: ref(120),
      columnVars: ref({ "--total-w": "120px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const CONDITION_HISTORY_STORAGE_KEY = "dbx-data-grid-condition-history";
const ORDER_BY_SCOPE = { connectionId: "conn-1", database: "db1", schema: undefined, tableName: "items" };

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function mountGrid(view: DataGridFilterEditorView) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    dataGridFilterEditorView: view,
    dataGridKeepFilterEditorExpanded: true,
  });
  const result = markRaw<QueryResult>({
    columns: ["id", "name"],
    rows: [[1, "Ada"]],
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const onExecuteSql = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(DataGrid, {
                result,
                databaseType: "mysql",
                context: "table-data",
                connectionId: "conn-1",
                database: "db1",
                tableMeta: {
                  tableName: "items",
                  columns: [
                    { name: "id", data_type: "int" },
                    { name: "name", data_type: "varchar" },
                  ],
                  primaryKeys: ["id"],
                },
                onExecuteSql,
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mountedApps.push({ app, host });
  return { host, onExecuteSql };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function sortToggle(host: HTMLElement): HTMLButtonElement {
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Sort"][aria-expanded]');
  if (!toggle) throw new Error("Sort editor toggle not found");
  return toggle;
}

async function selectSortColumn(workbench: Element, columnName: string) {
  const trigger = workbench.querySelector<HTMLElement>('[data-slot="select-trigger"]');
  if (!trigger) throw new Error("Sort column select trigger not found");
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await settle();

  // Drive the picker through the search field in the select header: its Enter handler
  // calls the component's own selectColumn(), which is far more stable under happy-dom
  // than synthesising pointer events on the reka-ui option elements.
  const search = document.querySelector<HTMLInputElement>("[data-sort-column-search] input");
  if (!search) throw new Error("Sort column search input not found");
  search.value = columnName;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
}

function storedOrderByHistory(): string[] {
  const raw = localStorage.getItem(CONDITION_HISTORY_STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { scopes?: Record<string, string[]> };
  return parsed.scopes?.[dataGridConditionHistoryScopeKey("orderBy", ORDER_BY_SCOPE)] ?? [];
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  clearDataGridSortBuilderMemoryCache();
  clearDataGridStructuredFilterStates();
  localStorage.removeItem(CONDITION_HISTORY_STORAGE_KEY);
});

describe("DataGrid ORDER BY history", () => {
  it("remembers a sort built with the sort builder so it can be restored from the history", async () => {
    const { host, onExecuteSql } = mountGrid("conditions");
    await settle();

    // Open the sort workbench and pick a column on the pre-seeded rule.
    sortToggle(host).click();
    await settle();
    const workbench = host.querySelector("[data-grid-sort-workbench]");
    if (!workbench) throw new Error("Sort workbench not found");
    await selectSortColumn(workbench, "name");

    // The workbench SQL preview is the signal that the sort builder produced a
    // usable clause, which is what "Apply Sort" then hands to the query path.
    expect(workbench.querySelector("code")?.textContent).toContain("`name` ASC");

    buttonByText(workbench, "Apply Sort").click();
    await settle();
    await vi.waitFor(() => expect(onExecuteSql).toHaveBeenCalled());

    expect(onExecuteSql.mock.calls[0][0]).toContain("ORDER BY `name` ASC");
    expect(storedOrderByHistory()).toContain("`name` ASC");
  });
});
