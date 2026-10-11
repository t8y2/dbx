// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

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

const RecycleScroller = defineComponent({
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
});

function mountGrid(options: { displayableColumns?: boolean; columns?: string[]; slots?: Record<string, () => ReturnType<typeof h>>; withTableMetadata?: boolean; context?: "table-data" | "results"; shortcut?: string; onExecuteSql?: () => void } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    shortcuts: {
      ...settingsStore.editorSettings.shortcuts,
      focusWhere: options.shortcut ?? "Mod+Shift+L",
    },
  });
  const result = markRaw<QueryResult>({
    columns: options.columns ?? ["id"],
    rows: [Array.from({ length: (options.columns ?? ["id"]).length }, (_, index) => index + 1)],
    affected_rows: 0,
    execution_time_ms: 0,
    hidden_column_indexes: options.displayableColumns === false ? [0] : undefined,
  });

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
              h(
                DataGrid,
                {
                  result,
                  databaseType: "mysql",
                  context: options.context ?? "table-data",
                  onExecuteSql: options.onExecuteSql ?? vi.fn(),
                  ...(options.withTableMetadata
                    ? {
                        connectionId: "test-connection",
                        database: "test-database",
                        tableMeta: { tableName: "users", schema: "test-database", columns: [], primaryKeys: [] },
                      }
                    : {}),
                },
                options.slots,
              ),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.component("RecycleScroller", RecycleScroller);
  app.mount(host);
  const mounted = { app, host };
  mountedApps.push(mounted);
  return { ...mounted, settingsStore };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function gridRoot(host: HTMLElement): HTMLElement {
  const root = host.querySelector<HTMLElement>("[data-grid-root]");
  if (!root) throw new Error("Data grid root not found");
  return root;
}

function focusWhereEvent(target: HTMLElement, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, shiftKey: true, key: "L", ...options });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid focus-WHERE shortcut", () => {
  it.each(["single", "split"] as const)("focuses WHERE without changing or executing its draft in the %s toolbar", async (layout) => {
    const execute = vi.fn();
    const { host, settingsStore } = mountGrid({ withTableMetadata: true, onExecuteSql: execute });
    settingsStore.updateEditorSettings({ dataGridToolbarLayout: layout });
    await settle();
    const where = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="WHERE"]')!;
    expect(where).not.toBeNull();
    where.value = "id = 42";
    where.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const root = gridRoot(host);
    root.focus();
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = focusWhereEvent(root);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(where);
    expect(where.value).toBe("id = 42");
    expect(execute).not.toHaveBeenCalled();
  });

  it("moves focus from ORDER BY to WHERE", async () => {
    const { host } = mountGrid({ withTableMetadata: true });
    await settle();
    const order = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="ORDER BY"]')!;
    order.focus();
    expect(focusWhereEvent(order).defaultPrevented).toBe(true);
    await settle();
    expect(document.activeElement).toBe(host.querySelector('textarea[aria-label="WHERE"]'));
  });

  it.each([{ withTableMetadata: false }, { withTableMetadata: true, context: "results" as const }, { withTableMetadata: true, shortcut: "" }])("leaves the key untouched when WHERE is unavailable or the binding is cleared: %j", async (options) => {
    const { host } = mountGrid(options);
    await settle();
    const root = gridRoot(host);
    root.focus();
    expect(focusWhereEvent(root).defaultPrevented).toBe(false);
    await settle();
    expect(document.activeElement).toBe(root);
  });

  it.each([{ isComposing: true }, { key: "J" }])("ignores composition and unmatched keys: %j", async (options) => {
    const { host } = mountGrid({ withTableMetadata: true });
    await settle();
    const root = gridRoot(host);
    root.focus();
    expect(focusWhereEvent(root, options).defaultPrevented).toBe(false);
    await settle();
    expect(document.activeElement).toBe(root);
  });
});
