// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";
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
      renderedColumnWidths: ref([120, 120]),
      totalWidth: ref(240),
      columnVars: ref({ "--total-w": "240px" }),
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

interface TableMeta {
  catalog?: string;
  schema?: string;
  tableName: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
}

function mountGrid(
  options: {
    context?: "results" | "table-data";
    databaseType?: DatabaseType;
    connectionId?: string;
    database?: string;
    tableMeta?: TableMeta | null;
    shortcut?: string;
    editable?: boolean;
  } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    shortcuts: {
      ...settingsStore.editorSettings.shortcuts,
      editCell: options.shortcut ?? "F2",
    },
  });
  const result = markRaw<QueryResult>({
    columns: ["id", "name"],
    rows: [
      [1, "Alice"],
      [2, "Bob"],
    ],
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const defaultTableMeta: TableMeta = {
    catalog: "warehouse",
    schema: "public",
    tableName: "users",
    columns: [],
    primaryKeys: ["id"],
  };

  const host = document.createElement("div");
  const grid = ref<{
    editSelectedCell: () => boolean;
    selectSingleCell: (row: number, col: number) => void;
  }>();
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
                ref: grid,
                result,
                databaseType: options.databaseType ?? "mysql",
                context: options.context ?? "table-data",
                editable: options.editable ?? true,
                connectionId: options.connectionId ?? "connection-1",
                database: options.database ?? "app",
                tableMeta: options.tableMeta === null ? undefined : (options.tableMeta ?? defaultTableMeta),
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
  mountedApps.push({ app, host });
  return { host, grid };
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

function dispatchKey(target: HTMLElement, key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid editCell shortcut", () => {
  it("enters cell editing when F2 is pressed on a selected cell", async () => {
    const { host, grid } = mountGrid();
    await settle();
    const root = gridRoot(host);
    grid.value?.selectSingleCell(0, 1);
    await settle();

    const event = dispatchKey(root, "F2");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector(".cell-edit-input")).not.toBeNull();
  });

  it("still enters cell editing when plain Enter is pressed", async () => {
    const { host, grid } = mountGrid();
    await settle();
    const root = gridRoot(host);
    grid.value?.selectSingleCell(0, 1);
    await settle();

    const event = dispatchKey(root, "Enter");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector(".cell-edit-input")).not.toBeNull();
  });

  it("uses a configured shortcut and leaves F2 unhandled when rebound", async () => {
    const { host, grid } = mountGrid({ shortcut: "Mod+E" });
    await settle();
    const root = gridRoot(host);
    grid.value?.selectSingleCell(0, 1);
    await settle();

    const defaultEvent = dispatchKey(root, "F2");
    await settle();
    expect(defaultEvent.defaultPrevented).toBe(false);
    expect(host.querySelector(".cell-edit-input")).toBeNull();

    const customEvent = dispatchKey(root, "e", { ctrlKey: true });
    await settle();
    expect(customEvent.defaultPrevented).toBe(true);
    expect(host.querySelector(".cell-edit-input")).not.toBeNull();
  });

  it("does not consume F2 when the grid is read-only", async () => {
    const { host, grid } = mountGrid({ editable: false });
    await settle();
    const root = gridRoot(host);
    grid.value?.selectSingleCell(0, 0);
    await settle();

    const event = dispatchKey(root, "F2");
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector(".cell-edit-input")).toBeNull();
  });

  it("leaves editable text targets untouched on F2", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const input = document.createElement("input");
    root.append(input);

    const event = dispatchKey(input, "F2");
    await settle();

    expect(event.defaultPrevented).toBe(false);
  });
});
