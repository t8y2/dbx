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

function mountGrid(options: { displayableColumns?: boolean; columns?: string[]; slots?: Record<string, () => ReturnType<typeof h>>; withTableMetadata?: boolean } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    shortcuts: {
      ...settingsStore.editorSettings.shortcuts,
      goToColumn: "Mod+G",
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
                  context: "table-data",
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

function goToColumnButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "Go to column");
  if (!button) throw new Error("Go-to-column button not found");
  return button;
}

function goToColumnItem(name: string, position: number): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.replaceAll(/\s/g, "") === `${name}#${position}`);
  if (!button) throw new Error(`Go-to-column item ${name} not found`);
  return button;
}

function goToColumnEvent(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "g" });
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

describe("DataGrid go-to-column shortcut", () => {
  it("switches between the split and original single-row toolbar layouts", async () => {
    const { host, settingsStore } = mountGrid();
    await settle();

    const topbar = host.querySelector<HTMLElement>("[data-grid-toolbar-layout]");
    expect(topbar?.dataset.gridToolbarLayout).toBe("single");

    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await settle();

    expect(topbar?.dataset.gridToolbarLayout).toBe("split");
    expect(topbar?.classList.contains("grid")).toBe(true);

    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "single" });
    await settle();

    expect(topbar?.dataset.gridToolbarLayout).toBe("single");
    expect(topbar?.classList.contains("flex")).toBe(true);
    expect(host.querySelector('[data-grid-topbar-row="actions"].ml-auto')).not.toBeNull();

    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await settle();

    expect(topbar?.dataset.gridToolbarLayout).toBe("split");
    expect(topbar?.classList.contains("grid")).toBe(true);
    expect(host.querySelector('[data-grid-topbar-row="filters"].data-grid-topbar-scroll--row-divider')).not.toBeNull();
  });

  it("does not show a DDL action in the result action toolbar", async () => {
    const { host } = mountGrid({ withTableMetadata: true });
    await settle();

    expect(host.querySelector('[data-toolbar-action="tableInfo"]')).toBeNull();
  });

  it("keeps result actions and query filters in their separate toolbar rows", async () => {
    const { host } = mountGrid({
      slots: {
        "result-toolbar-leading": () => h("span", { "data-testid": "result-view" }, "结果视图"),
        "result-toolbar-actions": () => h("span", { "data-testid": "result-actions" }, "结果操作"),
        "search-bar": () => h("span", { "data-testid": "search-controls" }, "文档筛选"),
      },
    });
    await settle();

    const actionRowSelector = '[data-grid-topbar-row="actions"]';
    const filterRowSelector = '[data-grid-topbar-row="filters"]';
    expect(host.querySelector('[data-testid="result-view"]')?.closest(actionRowSelector)).not.toBeNull();
    expect(host.querySelector('[data-testid="result-actions"]')?.closest(actionRowSelector)).not.toBeNull();
    expect(host.querySelector('[data-testid="search-controls"]')?.closest(filterRowSelector)).not.toBeNull();
  });

  it("opens and consumes the configured shortcut when a column is displayable", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    root.focus();
    expect(document.activeElement).toBe(root);

    const event = goToColumnEvent(root);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.getAttribute("placeholder")).toBe("Search column/comment...");
  });

  it("moves the lookup selection with arrows and chooses it with Enter", async () => {
    const { host } = mountGrid({ columns: ["id", "name"] });
    await settle();
    const root = gridRoot(host);
    root.focus();
    goToColumnEvent(root);
    await settle();

    const input = document.activeElement as HTMLInputElement;
    const down = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" });
    input.dispatchEvent(down);
    await settle();

    expect(down.defaultPrevented).toBe(true);
    expect(goToColumnItem("name", 2).classList).toContain("bg-accent");

    const enter = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
    input.dispatchEvent(enter);
    await settle();

    expect(enter.defaultPrevented).toBe(true);
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("false");
  });

  it("does not consume the configured shortcut without a displayable column", async () => {
    const { host } = mountGrid({ displayableColumns: false });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = goToColumnEvent(root);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("false");
  });

  it("does not trigger or consume shortcuts from editable targets", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const targets = [document.createElement("input"), document.createElement("textarea"), document.createElement("div"), document.createElement("div")];
    targets[2]!.setAttribute("contenteditable", "true");
    targets[3]!.setAttribute("role", "textbox");

    for (const target of targets) {
      root.append(target);
      const event = goToColumnEvent(target);
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();

    expect(bubbled).toHaveBeenCalledTimes(targets.length);
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves an unmatched root event untouched", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "j" });

    root.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("false");
  });
});
