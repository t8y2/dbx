// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ShortcutActionId } from "@/lib/editor/shortcutRegistry";

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

const dataGridSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGrid.vue"), "utf8");
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];
const shortcutCases = [
  { actionId: "goToFirstPage", key: "F1", offset: 0, functionName: "firstPage" },
  { actionId: "goToPreviousPage", key: "F2", offset: 100, functionName: "prevPage" },
  { actionId: "goToNextPage", key: "F3", offset: 300, functionName: "nextPage" },
  { actionId: "goToLastPage", key: "F4", offset: 400, functionName: "lastPage" },
] as const;

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

function mountGrid(
  options: {
    pageOffset?: number;
    totalRowCount?: number;
    loading?: boolean;
    paginationEnabled?: boolean;
    infiniteScroll?: boolean;
    empty?: boolean;
    configurePaginationShortcuts?: boolean;
  } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    infiniteScroll: options.infiniteScroll ?? false,
    shortcuts: {
      ...settingsStore.editorSettings.shortcuts,
      ...(options.configurePaginationShortcuts === false
        ? {}
        : {
            goToFirstPage: "Alt+F1",
            goToPreviousPage: "Alt+F2",
            goToNextPage: "Alt+F3",
            goToLastPage: "Alt+F4",
          }),
    },
  });
  const result = markRaw<QueryResult>({
    columns: ["id"],
    rows: options.empty ? [] : [[1]],
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const paginate = vi.fn();

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
                pageLimit: 100,
                pageOffset: options.pageOffset ?? 200,
                totalRowCount: options.totalRowCount ?? 500,
                loading: options.loading ?? false,
                paginationEnabled: options.paginationEnabled ?? true,
                onPaginate: paginate,
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
  const mounted = { app, host };
  mountedApps.push(mounted);
  return { host, paginate };
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

function dispatchShortcut(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, altKey: true, key });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid pagination shortcuts", () => {
  it.each(shortcutCases)("runs $functionName through the configured $actionId shortcut", async ({ key, offset }) => {
    const { host, paginate } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    root.focus();

    const event = dispatchShortcut(root, key);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.slice(0, 2)).toEqual([offset, 100]);
  });

  it.each([
    ["goToFirstPage", "F1"],
    ["goToPreviousPage", "F2"],
  ] as const)("does not consume %s on the first page", async (_actionId, key) => {
    const { host, paginate } = mountGrid({ pageOffset: 0 });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchShortcut(root, key);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(paginate).not.toHaveBeenCalled();
  });

  it.each([
    ["goToNextPage", "F3"],
    ["goToLastPage", "F4"],
  ] as const)("does not consume %s on the last page", async (_actionId, key) => {
    const { host, paginate } = mountGrid({ pageOffset: 400 });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchShortcut(root, key);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(paginate).not.toHaveBeenCalled();
  });

  it.each([
    ["loading", { loading: true }],
    ["disabled pagination", { paginationEnabled: false }],
    ["infinite scroll", { infiniteScroll: true }],
    ["no available pages", { pageOffset: 0, totalRowCount: 0, empty: true }],
  ] as const)("does not consume pagination shortcuts during %s", async (_label, options) => {
    const { host, paginate } = mountGrid(options);
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    for (const { key } of shortcutCases) {
      const event = dispatchShortcut(root, key);
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();

    expect(bubbled).toHaveBeenCalledTimes(shortcutCases.length);
    expect(paginate).not.toHaveBeenCalled();
  });

  it("does not trigger or consume pagination shortcuts from editable targets", async () => {
    const { host, paginate } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const targets = [document.createElement("input"), document.createElement("textarea"), document.createElement("div"), document.createElement("div")];
    targets[2]!.setAttribute("contenteditable", "true");
    targets[3]!.setAttribute("role", "textbox");

    for (const target of targets) {
      root.append(target);
      const event = dispatchShortcut(target, "F3");
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();

    expect(bubbled).toHaveBeenCalledTimes(targets.length);
    expect(paginate).not.toHaveBeenCalled();
  });

  it("routes shortcuts to the existing pagination functions and preserves PageUp/PageDown navigation", () => {
    expect(dataGridSource).toMatch(/if \(!targetAllowsNativeClipboard && handleGridPaginationShortcut\(event\)\) return;/);
    for (const { actionId, functionName } of shortcutCases) {
      expect(dataGridSource).toContain(`is${actionId[0]!.toUpperCase()}${actionId.slice(1)}Shortcut(event, shortcuts)`);
      expect(dataGridSource).toContain(`navigate = ${functionName}`);
    }
    expect(dataGridSource).toContain('event.key === "PageUp" && navigateSelectedCell("pageUp", event.shiftKey)');
    expect(dataGridSource).toContain('event.key === "PageDown" && navigateSelectedCell("pageDown", event.shiftKey)');
  });

  it("keeps legacy settings without pagination mappings keyboard-neutral", async () => {
    const { host, paginate } = mountGrid({ configurePaginationShortcuts: false });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchShortcut(root, "F3");
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(paginate).not.toHaveBeenCalled();
    const actionIds: ShortcutActionId[] = shortcutCases.map(({ actionId }) => actionId);
    expect(actionIds).toHaveLength(4);
  });
});
