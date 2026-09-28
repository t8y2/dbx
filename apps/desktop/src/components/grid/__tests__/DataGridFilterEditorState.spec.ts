// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DataGridFilterEditorView } from "@/stores/settingsStore";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearDataGridStructuredFilterStates } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";

const backendMocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(async ({ tableName, whereInput }: { tableName: string; whereInput?: string }) => `SELECT * FROM ${tableName}${whereInput ? ` WHERE ${whereInput}` : ""}`),
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

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function panelSelector(view: DataGridFilterEditorView): string {
  return view === "conditions" ? "[data-grid-filter-workbench]" : "[data-grid-text-filter-workbench]";
}

function filterToggle(host: HTMLElement): HTMLButtonElement {
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Filter"][aria-expanded]');
  if (!toggle) throw new Error("Filter editor toggle not found");
  return toggle;
}

function applyButton(host: HTMLElement, view: DataGridFilterEditorView): HTMLButtonElement {
  const panel = host.querySelector(panelSelector(view));
  const button = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent?.trim() === "Apply Filter");
  if (!button) throw new Error("Filter editor apply button not found");
  return button;
}

function mountGrid(view: DataGridFilterEditorView, keepExpanded: boolean) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    dataGridFilterEditorView: view,
    dataGridKeepFilterEditorExpanded: keepExpanded,
  });
  const result = markRaw<QueryResult>({
    columns: ["id"],
    rows: [[1]],
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
                tableMeta: {
                  tableName: "items",
                  columns: [{ name: "id", data_type: "int" }],
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
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  clearDataGridStructuredFilterStates();
});

describe.each(["conditions", "text"] as const)("DataGrid %s filter editor state", (view) => {
  it("keeps a manually opened editor open after apply and still allows manual close", async () => {
    const { host, onExecuteSql } = mountGrid(view, false);
    await settle();

    expect(host.querySelector(panelSelector(view))).toBeNull();
    filterToggle(host).click();
    await settle();
    expect(host.querySelector(panelSelector(view))).not.toBeNull();

    applyButton(host, view).click();
    await vi.waitFor(() => expect(onExecuteSql).toHaveBeenCalledOnce());
    expect(host.querySelector(panelSelector(view))).not.toBeNull();

    filterToggle(host).click();
    await settle();
    expect(host.querySelector(panelSelector(view))).toBeNull();
  });

  it("uses the persisted expansion preference only as the initial state", async () => {
    const { host } = mountGrid(view, true);
    await settle();

    expect(host.querySelector(panelSelector(view))).not.toBeNull();
    expect(filterToggle(host).getAttribute("aria-expanded")).toBe("true");

    filterToggle(host).click();
    await settle();
    expect(host.querySelector(panelSelector(view))).toBeNull();

    filterToggle(host).click();
    await settle();
    expect(host.querySelector(panelSelector(view))).not.toBeNull();
  });
});

describe("DataGrid quick filter editor state", () => {
  it("continues to close its popover after apply", async () => {
    const { host, onExecuteSql } = mountGrid("quick", true);
    await settle();

    const toggle = filterToggle(host);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    await settle();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const apply = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "Apply Filter");
    if (!apply) throw new Error("Quick filter apply button not found");
    apply.click();
    await vi.waitFor(() => expect(onExecuteSql).toHaveBeenCalledOnce());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
