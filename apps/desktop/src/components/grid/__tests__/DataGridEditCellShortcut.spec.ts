// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    RecycleScroller: defineComponent({
      props: { items: { type: Array as PropType<unknown[]>, default: () => [] } },
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
    renderMode?: "canvas" | "dom";
  } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: options.renderMode ?? "canvas",
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
    column_types: ["int", "varchar"],
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

function dataCell(host: HTMLElement, row: number, col: number): HTMLElement {
  const rowElement = host.querySelectorAll<HTMLElement>(".data-grid-row")[row];
  const cell = rowElement?.querySelector<HTMLElement>(`[data-visible-col-index="${col}"]`);
  if (!cell) throw new Error(`Cell not found: ${row}:${col}`);
  return cell;
}

async function selectDataCell(host: HTMLElement, row: number, col: number, shiftKey = false) {
  dataCell(host, row, col).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  await settle();
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
    expect(root.hasAttribute("data-cell-edit-selection-style")).toBe(false);
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

  it("moves focus from the SQL editor to a clicked cell and starts editing on a printable key", async () => {
    const { host } = mountGrid({ renderMode: "dom" });
    await settle();
    const root = gridRoot(host);
    const sqlEditor = document.createElement("input");
    host.append(sqlEditor);
    sqlEditor.focus();
    expect(document.activeElement).toBe(sqlEditor);

    dataCell(host, 0, 1).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.activeElement).toBe(root);
    sqlEditor.focus();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    expect(document.activeElement).toBe(root);
    const event = dispatchKey(document.activeElement as HTMLElement, "Z");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    const editor = host.querySelector<HTMLInputElement>(".cell-edit-input");
    expect(editor?.value).toBe("Z");
    expect(root.hasAttribute("data-cell-edit-selection-style")).toBe(true);
    expect(sqlEditor.value).toBe("");
  });

  it("routes input to the selected cell even if SQL steals focus later, then releases it when SQL is clicked", async () => {
    const { host } = mountGrid({ renderMode: "dom" });
    await settle();
    const sqlEditor = document.createElement("input");
    sqlEditor.value = "SELECT 1";
    host.append(sqlEditor);
    await selectDataCell(host, 0, 0);

    sqlEditor.focus();
    const gridInput = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
    Object.defineProperty(gridInput, "keyCode", { value: 229 });
    Object.defineProperty(gridInput, "which", { value: 229 });
    sqlEditor.dispatchEvent(gridInput);
    const nativeTextInput = new InputEvent("beforeinput", { data: "1", inputType: "insertText", bubbles: true, cancelable: true });
    sqlEditor.dispatchEvent(nativeTextInput);
    if (!nativeTextInput.defaultPrevented) sqlEditor.value += "1";
    await settle();

    expect(gridInput.defaultPrevented).toBe(true);
    expect(nativeTextInput.defaultPrevented).toBe(true);
    expect(host.querySelector<HTMLInputElement>(".cell-edit-input")?.value).toBe("1");
    expect(sqlEditor.value).toBe("SELECT 1");

    sqlEditor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    sqlEditor.focus();
    const sqlInput = dispatchKey(sqlEditor, "2");
    if (!sqlInput.defaultPrevented) sqlEditor.value += "2";
    await settle();

    expect(sqlInput.defaultPrevented).toBe(false);
    expect(sqlEditor.value).toBe("SELECT 12");
  });

  it("retains grid focus after a canvas cell selection finishes", async () => {
    const { host } = mountGrid({ renderMode: "canvas" });
    await settle();
    const root = gridRoot(host);
    const canvas = host.querySelector<HTMLCanvasElement>("canvas.canvas-grid-surface");
    const sqlEditor = document.createElement("input");
    host.append(sqlEditor);
    sqlEditor.focus();

    canvas!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 60, clientY: 5 }));
    expect(document.activeElement).toBe(root);
    sqlEditor.focus();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    await settle();

    expect(document.activeElement).toBe(root);
    dispatchKey(document.activeElement as HTMLElement, "1");
    await settle();
    expect(host.querySelector<HTMLInputElement>(".cell-edit-input")?.value).toBe("1");
  });

  it.each(["dom", "canvas"] as const)("keeps numeric cell alignment during selection-style editing in %s mode", async (renderMode) => {
    const { host, grid } = mountGrid({ renderMode });
    await settle();
    const root = gridRoot(host);
    grid.value?.selectSingleCell(0, 0);
    await settle();

    dispatchKey(root, "7");
    await settle();

    expect(host.querySelector<HTMLInputElement>(".cell-edit-input")?.value).toBe("7");
    expect(root.hasAttribute("data-cell-edit-selection-style")).toBe(true);
    expect(root.style.getPropertyValue("--data-grid-cell-edit-text-align")).toBe("right");
  });

  it("previews every selected cell while typing and restores all of them on Escape", async () => {
    const { host } = mountGrid({ renderMode: "dom" });
    await settle();
    const root = gridRoot(host);
    await selectDataCell(host, 0, 1);
    await selectDataCell(host, 1, 1, true);

    dispatchKey(root, "X");
    await settle();
    const editor = host.querySelector<HTMLInputElement>(".cell-edit-input");
    expect(editor?.value).toBe("X");
    expect(root.hasAttribute("data-cell-edit-selection-style")).toBe(true);
    expect(dataCell(host, 1, 1).textContent?.trim()).toBe("X");

    editor!.value = "XY";
    editor!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(dataCell(host, 1, 1).textContent?.trim()).toBe("XY");

    dispatchKey(editor!, "Escape");
    await settle();
    expect(host.querySelector(".cell-edit-input")).toBeNull();
    expect(root.hasAttribute("data-cell-edit-selection-style")).toBe(false);
    expect(dataCell(host, 0, 1).textContent?.trim()).toBe("Alice");
    expect(dataCell(host, 1, 1).textContent?.trim()).toBe("Bob");
  });

  it("commits the previewed value to every selected cell on Enter", async () => {
    const { host } = mountGrid({ renderMode: "dom" });
    await settle();
    await selectDataCell(host, 0, 1);
    await selectDataCell(host, 1, 1, true);

    dispatchKey(gridRoot(host), "X");
    await settle();
    dispatchKey(host.querySelector<HTMLInputElement>(".cell-edit-input")!, "Enter");
    await settle();

    expect(host.querySelector(".cell-edit-input")).toBeNull();
    expect(dataCell(host, 0, 1).textContent?.trim()).toBe("X");
    expect(dataCell(host, 1, 1).textContent?.trim()).toBe("X");
  });

  it("keeps the full input styling for double-click editing", async () => {
    const { host } = mountGrid({ renderMode: "dom" });
    await settle();
    const root = gridRoot(host);

    dataCell(host, 0, 1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0 }));
    await vi.waitFor(() => expect(host.querySelector(".cell-edit-input")).not.toBeNull());

    const editor = host.querySelector<HTMLInputElement>(".cell-edit-input");
    expect(editor?.value).toBe("Alice");
    expect(root.hasAttribute("data-cell-edit-selection-style")).toBe(false);
  });
});
