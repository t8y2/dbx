// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  buildDataGridContextFilterCondition: vi.fn(),
  buildTableSelectSql: vi.fn(async () => "SELECT 1"),
  executeMulti: vi.fn(),
  cancelQuery: vi.fn(),
  extractDataGridSelection: vi.fn(),
  copyToClipboard: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  buildDataGridContextFilterCondition: mocks.buildDataGridContextFilterCondition,
  buildTableSelectSql: mocks.buildTableSelectSql,
  executeMulti: mocks.executeMulti,
  cancelQuery: mocks.cancelQuery,
  extractDataGridSelection: mocks.extractDataGridSelection,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/common/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/common/clipboard")>();
  return {
    ...actual,
    copyToClipboard: mocks.copyToClipboard,
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
      hasUserSizedColumns: ref(false),
      renderedColumnWidths: ref([120, 180]),
      totalWidth: ref(300),
      columnVars: ref({ "--total-w": "300px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const RecycleScroller = defineComponent({
  props: {
    items: { type: Array, default: () => [] },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "div",
        attrs,
        props.items.map((item: unknown) => slots.default?.({ item })),
      );
  },
});

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function tabularResult(): QueryResult {
  return {
    columns: ["id", "payload"],
    column_types: ["int", "text"],
    rows: [[1, "value"]],
    affected_rows: 0,
    execution_time_ms: 0,
  };
}

function mountGrid(sendResultToAiEnabled: boolean | undefined) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "canvas" });
  const onSendResultToAi = vi.fn();

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
                result: markRaw(tabularResult()),
                databaseType: "mysql",
                connectionId: "connection-1",
                database: "dbx",
                context: "results",
                ...(sendResultToAiEnabled === undefined ? {} : { sendResultToAiEnabled }),
                onSendResultToAi,
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.component("RecycleScroller", RecycleScroller);
  app.mount(host);
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  const mounted = { app, host };
  mountedApps.push(mounted);
  return { host, onSendResultToAi };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function contextMenuLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].map((button) => button.textContent?.trim() ?? "");
}

function contextMenuButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Context menu item not found: ${label}`);
  return button;
}

async function openResultCellMenu(host: HTMLElement) {
  const cell = host.querySelector<HTMLElement>('[data-row-index="0"] [data-visible-col-index="0"]');
  if (!cell) throw new Error("Result grid cell not found");
  cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.querySelectorAll("[data-dbx-context-menu]").forEach((menu) => menu.remove());
});

describe("DataGrid send result to AI menu entry", () => {
  it("hides the entry when the host does not enable it", async () => {
    const { host } = mountGrid(undefined);
    await settle();

    await openResultCellMenu(host);

    expect(contextMenuLabels()).not.toContain("Send result to AI");
    // The rest of the menu still renders — the assertion above is not vacuous.
    expect(contextMenuLabels()).toContain("Copy");
  });

  it("shows the entry when enabled and emits sendResultToAi on click", async () => {
    const { host, onSendResultToAi } = mountGrid(true);
    await settle();

    await openResultCellMenu(host);

    expect(contextMenuLabels()).toContain("Send result to AI");
    contextMenuButton("Send result to AI").click();
    await settle();

    expect(onSendResultToAi).toHaveBeenCalledTimes(1);
  });
});
