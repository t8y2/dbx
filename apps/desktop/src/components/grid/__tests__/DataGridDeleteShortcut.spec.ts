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
    deleteRowShortcut?: string;
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
      ...(options.deleteRowShortcut ? { deleteCurrentRow: options.deleteRowShortcut } : {}),
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
    columns: [
      { name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
    primaryKeys: ["id"],
  };

  const host = document.createElement("div");
  const grid = ref<{
    selectSingleCell: (row: number, col: number) => void;
    selectRow: (rowIndex: number) => void;
    hasRowSelection: boolean;
    displayItems: Array<{ id: number; data: unknown[]; isDirtyCol: boolean[] }>;
    hasPendingChanges: boolean;
    showDeleteRowConfirm: boolean;
    pendingDeleteRowIds: number[];
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

describe("DataGrid delete key cell null and row delete behavior", () => {
  it("sets selected cell value to null when Delete key is pressed without deleting the row (#11958)", async () => {
    const { host, grid } = mountGrid();
    await settle();
    const root = gridRoot(host);
    grid.value?.selectSingleCell(0, 1);
    await settle();

    expect(grid.value?.displayItems[0]?.data[1]).toBe("Alice");
    expect(grid.value?.hasRowSelection).toBe(false);

    const event = dispatchKey(root, "Delete");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(grid.value?.displayItems[0]?.data[1]).toBeNull();
    expect(grid.value?.displayItems[0]?.isDirtyCol[1]).toBe(true);
    expect(grid.value?.displayItems.length).toBe(2);
    expect(grid.value?.showDeleteRowConfirm).toBe(false);
  });

  it("sets selected cell value to null when Backspace key is pressed (macOS delete key) (#11958)", async () => {
    const { host, grid } = mountGrid();
    await settle();
    const root = gridRoot(host);
    grid.value?.selectSingleCell(1, 1);
    await settle();

    expect(grid.value?.displayItems[1]?.data[1]).toBe("Bob");
    expect(grid.value?.hasRowSelection).toBe(false);

    const event = dispatchKey(root, "Backspace");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(grid.value?.displayItems[1]?.data[1]).toBeNull();
    expect(grid.value?.displayItems[1]?.isDirtyCol[1]).toBe(true);
    expect(grid.value?.displayItems.length).toBe(2);
    expect(grid.value?.showDeleteRowConfirm).toBe(false);
  });

  it("triggers row deletion when a whole row is selected and Delete is pressed", async () => {
    const { host, grid } = mountGrid();
    await settle();
    const root = gridRoot(host);
    grid.value?.selectRow(0);
    await settle();

    expect(grid.value?.hasRowSelection).toBe(true);

    const event = dispatchKey(root, "Delete");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(grid.value?.showDeleteRowConfirm).toBe(true);
    expect(grid.value?.pendingDeleteRowIds.length).toBeGreaterThan(0);
    // Cell value is not set to null
    expect(grid.value?.displayItems[0]?.data[1]).toBe("Alice");
  });

  it("does not modify cell or delete row when the grid is read-only", async () => {
    const { host, grid } = mountGrid({ editable: false });
    await settle();
    const root = gridRoot(host);
    grid.value?.selectSingleCell(0, 1);
    await settle();

    const event = dispatchKey(root, "Delete");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(grid.value?.displayItems[0]?.data[1]).toBe("Alice");
    expect(grid.value?.displayItems.length).toBe(2);
    expect(grid.value?.showDeleteRowConfirm).toBe(false);
  });

  it("leaves editable input targets untouched on Delete key", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const input = document.createElement("input");
    root.append(input);

    const event = dispatchKey(input, "Delete");
    await settle();

    expect(event.defaultPrevented).toBe(false);
  });

  it("supports custom deleteCurrentRow shortcut while still allowing Delete key on cells", async () => {
    const { host, grid } = mountGrid({ deleteRowShortcut: "Mod+Shift+K" });
    await settle();
    const root = gridRoot(host);
    grid.value?.selectSingleCell(0, 1);
    await settle();

    // Plain Delete still clears cell to null
    const deleteEvent = dispatchKey(root, "Delete");
    await settle();
    expect(deleteEvent.defaultPrevented).toBe(true);
    expect(grid.value?.displayItems[0]?.data[1]).toBeNull();
    expect(grid.value?.showDeleteRowConfirm).toBe(false);

    // Custom shortcut Mod+Shift+K triggers row deletion
    const customEvent = dispatchKey(root, "K", { ctrlKey: true, shiftKey: true });
    await settle();
    expect(customEvent.defaultPrevented).toBe(true);
    expect(grid.value?.showDeleteRowConfirm).toBe(true);
  });
});
