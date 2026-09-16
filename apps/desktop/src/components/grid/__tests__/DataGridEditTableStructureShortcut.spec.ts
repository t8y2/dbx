// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
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
      renderedColumnWidths: ref([120]),
      totalWidth: ref(120),
      columnVars: ref({ "--total-w": "120px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const dataGridSource = readFileSync(resolve(import.meta.dirname, "../DataGrid.vue"), "utf8");
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
  } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    shortcuts: {
      ...settingsStore.editorSettings.shortcuts,
      editTableStructure: options.shortcut ?? "Mod+D",
    },
  });
  const queryStore = useQueryStore();
  const openTableStructure = vi.spyOn(queryStore, "openTableStructure").mockImplementation(() => "structure-tab");
  const result = markRaw<QueryResult>({
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const defaultTableMeta: TableMeta = {
    catalog: "warehouse",
    schema: "public",
    tableName: "users",
    columns: [],
    primaryKeys: [],
  };

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
                databaseType: options.databaseType ?? "mysql",
                context: options.context ?? "table-data",
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
  return { host, openTableStructure };
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

function dispatchModShortcut(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key });
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

describe("DataGrid edit-table-structure shortcut", () => {
  it("opens the existing structure editor route for an eligible table-data grid", async () => {
    const { host, openTableStructure } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    root.focus();

    const event = dispatchModShortcut(root, "d");
    await settle();

    expect(document.activeElement).toBe(root);
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(openTableStructure).toHaveBeenCalledOnce();
    expect(openTableStructure).toHaveBeenCalledWith("connection-1", "app", "public", "users", "ddl", undefined, "warehouse");
  });

  it("uses a configured shortcut and leaves the default key untouched", async () => {
    const { host, openTableStructure } = mountGrid({ shortcut: "Mod+E" });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const defaultEvent = dispatchModShortcut(root, "d");
    const customEvent = dispatchModShortcut(root, "e");
    await settle();

    expect(defaultEvent.defaultPrevented).toBe(false);
    expect(customEvent.defaultPrevented).toBe(true);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(openTableStructure).toHaveBeenCalledOnce();
  });

  it.each([
    ["query result", { context: "results" as const }],
    ["unsupported database", { databaseType: "redis" as const }],
    ["missing connection", { connectionId: "" }],
    ["missing database", { database: "" }],
    ["missing table metadata", { tableMeta: null }],
  ])("does not consume the shortcut for %s", async (_label, options) => {
    const { host, openTableStructure } = mountGrid(options);
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchModShortcut(root, "d");
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(openTableStructure).not.toHaveBeenCalled();
  });

  it("leaves editable text targets untouched", async () => {
    const { host, openTableStructure } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const targets = [document.createElement("input"), document.createElement("textarea"), document.createElement("div"), document.createElement("div")];
    targets[2]!.setAttribute("contenteditable", "true");
    targets[3]!.setAttribute("role", "textbox");

    for (const target of targets) {
      root.append(target);
      const event = dispatchModShortcut(target, "d");
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();

    expect(bubbled).toHaveBeenCalledTimes(targets.length);
    expect(openTableStructure).not.toHaveBeenCalled();
  });

  it("preserves Ctrl+C for a native clipboard selection", async () => {
    const { host, openTableStructure } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const region = document.createElement("div");
    region.setAttribute("data-native-clipboard", "true");
    region.textContent = "selected table information";
    root.append(region);
    const range = document.createRange();
    range.selectNodeContents(region);
    window.getSelection()?.addRange(range);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchModShortcut(region, "c");
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(openTableStructure).not.toHaveBeenCalled();
  });

  it("routes through the existing guarded action and keeps the button path", () => {
    const start = dataGridSource.indexOf("async function onGridKeydown");
    const end = dataGridSource.indexOf("function copyDetailValue", start);
    const keydown = dataGridSource.slice(start, end);

    expect(keydown).toMatch(
      /if \(!targetAllowsNativeClipboard && props\.context === "table-data" && canOpenTableStructureEditor\.value && isEditTableStructureShortcut\(event, settingsStore\.editorSettings\.shortcuts\)\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?openTableStructureEditor\(\);[\s\S]*?return;/,
    );
    expect(dataGridSource).toMatch(/<Button v-if="canOpenTableStructureEditor"[^>]*@click="openTableStructureEditor">/);
  });
});
