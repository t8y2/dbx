// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DatabaseType, QueryResult } from "@/types/database";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
import { DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS, DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS } from "@/lib/dataGrid/dataGridCopyExtractor";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  buildDataGridContextFilterCondition: vi.fn(async ({ columnName, value }: { columnName: string; value: unknown }) => `\`${columnName}\` = '${String(value)}'`),
  buildTableSelectSql: vi.fn(async ({ whereInput }: { whereInput?: string }) => `SELECT payload FROM events${whereInput ? ` WHERE ${whereInput}` : ""}`),
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

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function largeValueResult(id = 1, value = "preview"): QueryResult {
  return {
    columns: ["id", "payload"],
    rows: [[id, value]],
    affected_rows: 0,
    execution_time_ms: 0,
    large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 4096 }],
  };
}

function hydratedResult(id: number, value: string): QueryResult {
  return {
    columns: ["id", "payload"],
    rows: [[id, value]],
    affected_rows: 0,
    execution_time_ms: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockDeferredFullHydration(hydration: Promise<QueryResult[]>) {
  mocks.executeMulti.mockImplementation((...args: unknown[]) => {
    const options = args[5] as { tableDataPreview?: boolean } | undefined;
    return options?.tableDataPreview ? Promise.resolve([hydratedResult(1, "visible preview")]) : hydration;
  });
}

function fullHydrationCallCount() {
  return mocks.executeMulti.mock.calls.filter((call) => !(call[5] as { tableDataPreview?: boolean } | undefined)?.tableDataPreview).length;
}

function visibleHydrationCalls() {
  return mocks.executeMulti.mock.calls.filter((call) => (call[5] as { tableDataPreview?: boolean } | undefined)?.tableDataPreview);
}

function gridCell(host: HTMLElement): HTMLElement {
  const cell = host.querySelector<HTMLElement>('[data-row-index="0"] [data-visible-col-index="1"]');
  if (!cell) throw new Error("Large-value grid cell not found");
  return cell;
}

function pasteGridCell(host: HTMLElement, value: string) {
  const cell = gridCell(host);
  cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => value } });
  const gridRoot = host.querySelector<HTMLElement>("[data-grid-root]");
  if (!gridRoot) throw new Error("Data grid root not found");
  gridRoot.dispatchEvent(paste);
}

function mountGrid(initialResult = largeValueResult(), onReload?: () => void, databaseType: DatabaseType = "mysql", tableMeta?: DataGridTableMeta, columnLayoutScopeKey?: string) {
  const result = shallowRef(markRaw(initialResult));
  const onExecuteSql = vi.fn().mockResolvedValue(undefined);
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "canvas" });

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
                result: result.value,
                databaseType,
                connectionId: "connection-1",
                database: "dbx",
                ...(columnLayoutScopeKey ? { columnLayoutScopeKey } : {}),
                context: "table-data",
                editable: true,
                tableMeta: tableMeta ?? {
                  tableName: "events",
                  columns: [
                    { name: "id", data_type: "int" },
                    { name: "payload", data_type: "text" },
                  ],
                  primaryKeys: ["id"],
                },
                onExecuteSql,
                ...(onReload ? { onReload } : {}),
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
  // Mount once with the production-default Canvas mode so DataGrid finishes
  // setting up its column-width dependencies, then exercise the DOM grid.
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  const mounted = { app, host };
  mountedApps.push(mounted);
  return {
    host,
    settingsStore,
    onExecuteSql,
    replaceResult: (nextResult: QueryResult) => (result.value = markRaw(nextResult)),
    unmount: () => {
      const index = mountedApps.indexOf(mounted);
      if (index >= 0) mountedApps.splice(index, 1);
      app.unmount();
      host.remove();
    },
  };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function contextMenuButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Context menu item not found: ${label}`);
  return button;
}

function contextMenuLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].map((button) => button.textContent?.trim() ?? "");
}

function columnHeader(host: HTMLElement, index: number): HTMLElement {
  const header = host.querySelector<HTMLElement>(`[data-grid-column-index="${index}"]`);
  if (!header) throw new Error(`Column header not found: ${index}`);
  return header;
}

function selectAllHeader(host: HTMLElement): HTMLElement {
  const header = host.querySelector<HTMLElement>(".data-grid-header-cell:not([data-grid-column-index])");
  if (!header) throw new Error("Select-all header not found");
  return header;
}

function rowNumber(host: HTMLElement, rowIndex = 0): HTMLElement {
  const cell = host.querySelector<HTMLElement>(`[data-row-index="${rowIndex}"] .data-grid-row-number`);
  if (!cell) throw new Error(`Row number not found: ${rowIndex}`);
  return cell;
}

function openContextMenu(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
}

async function startEqualsFilter(host: HTMLElement) {
  await settle();
  const cell = host.querySelector<HTMLElement>('[data-row-index="0"] [data-visible-col-index="1"]');
  if (!cell) throw new Error("Large-value grid cell not found");
  cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
  await settle();
  contextMenuButton("Filter").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  await settle();
  contextMenuButton("Filter by This Value").click();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelQuery.mockResolvedValue(true);
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.querySelectorAll("[data-dbx-context-menu]").forEach((menu) => menu.remove());
});

describe("DataGrid context menu target lifecycle", () => {
  it("offers original text for a single column spanning multiple rows", async () => {
    const lines = ["CREATE view v_Test as", "\tselect 'quoted' as value", '-- "keep quotes"'];
    mocks.extractDataGridSelection.mockResolvedValueOnce({ text: lines.join("\n"), mimeType: "text/plain", fileExtension: "txt", rowCount: 3, columnCount: 1 });
    mocks.copyToClipboard.mockResolvedValueOnce(true);
    const { host } = mountGrid({ columns: ["id", "payload"], rows: lines.map((line, index) => [index + 1, line]), affected_rows: 0, execution_time_ms: 0 });
    await settle();
    columnHeader(host, 1).click();
    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();

    contextMenuButton("Original Text (Single Column)").click();

    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith(lines.join("\n")));
    expect(mocks.extractDataGridSelection).toHaveBeenCalledWith(expect.objectContaining({ extractor: "raw", rows: lines.map((line) => [line]) }));
  });

  it("does not reuse a closed header target for a later select-all menu", async () => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    openContextMenu(columnHeader(host, 0));
    await settle();
    expect(contextMenuLabels()).toContain("Copy Column Name");

    const cell = gridCell(host);
    cell.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    await settle();

    selectAllHeader(host).click();
    openContextMenu(selectAllHeader(host));
    await settle();

    expect(contextMenuLabels()).toContain("Copy");
    expect(contextMenuLabels()).not.toContain("Copy Column Name");
    expect(contextMenuLabels()).not.toContain("Freeze to This Column");
  });

  it("keeps single- and multi-column header menus targeted", async () => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    openContextMenu(columnHeader(host, 0));
    await settle();
    expect(contextMenuLabels()).toContain("Copy Column Name");

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    columnHeader(host, 1).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
    openContextMenu(columnHeader(host, 1));
    await settle();

    expect(contextMenuLabels()).toContain("Copy Selected Column Names (2)");
    expect(contextMenuLabels()).toContain("Freeze Selected Columns (2)");
  });

  it("offers snapshots for full-column selections from the column header", async () => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    openContextMenu(columnHeader(host, 1));
    await settle();

    expect(contextMenuLabels()).toContain("Screenshot selected columns");
    contextMenuButton("Screenshot selected columns").click();
    await settle();
    expect(document.body.textContent).toContain("Grid Snapshot");
  });

  it("offers snapshots for full-row selections from the row number", async () => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    openContextMenu(rowNumber(host));
    await settle();

    expect(contextMenuLabels()).toContain("Screenshot selected rows");
    contextMenuButton("Screenshot selected rows").click();
    await settle();
    expect(document.body.textContent).toContain("Grid Snapshot");
  });

  it("formats Oracle date cells to display format in grid snapshot", async () => {
    const oracleResult: QueryResult = {
      columns: ["id", "created_at"],
      column_types: ["number", "DATE"],
      rows: [[1, "2026-10-09T10:56:57"]],
      affected_rows: 0,
      execution_time_ms: 0,
    };
    const oracleTableMeta: DataGridTableMeta = {
      tableName: "events",
      columns: [
        { name: "id", data_type: "number" },
        { name: "created_at", data_type: "DATE" },
      ],
      primaryKeys: ["id"],
    };
    const { host } = mountGrid(oracleResult, undefined, "oracle", oracleTableMeta);
    await settle();

    openContextMenu(rowNumber(host));
    await settle();

    expect(contextMenuLabels()).toContain("Screenshot selected rows");
    contextMenuButton("Screenshot selected rows").click();
    await settle();
    expect(document.body.textContent).toContain("Grid Snapshot");
    expect(document.body.textContent).toContain("2026-10-09 10:56:57");
    expect(document.body.textContent).not.toContain("2026-10-09T10:56:57");
  });

  it.each(["WHERE", "ORDER BY"] as const)("keeps the native context menu for the %s condition editor", async (placeholder) => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    const input = host.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${placeholder}"]`);
    expect(input).not.toBeNull();

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 });
    input!.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-dbx-context-menu]")).toBeNull();
  });

  it("keeps the DataGrid context menu for a regular cell", async () => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    openContextMenu(gridCell(host));
    await settle();

    expect(contextMenuLabels()).toContain("Filter");
  });

  it("offers extractor file exports for the selected cell", async () => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Export").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();

    expect(contextMenuButton("Original Text (Single Column)").disabled).toBe(false);
    expect(contextMenuButton("JSON Array").disabled).toBe(false);
    expect(contextMenuButton("SQL Select").disabled).toBe(false);
  });

  it("keeps unsupported extractor exports disabled for a whole-column selection", async () => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    columnHeader(host, 1).click();
    await settle();
    openContextMenu(columnHeader(host, 1));
    await settle();
    contextMenuButton("Export").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();

    expect(contextMenuButton("JSON Array").disabled).toBe(false);
    expect(contextMenuButton("SQL Select").disabled).toBe(true);
  });

  it("shows the large table preview notice when values are truncated", async () => {
    const { host } = mountGrid(largeValueResult(1, "preview"));
    await settle();
    expect(host.querySelector("[data-grid-preview-notice]")).toBeTruthy();
  });

  it("does not show the large table preview notice for fully loaded values", async () => {
    const { host } = mountGrid(hydratedResult(1, "preview"));
    await settle();
    expect(host.querySelector("[data-grid-preview-notice]")).toBeNull();
  });

  it("re-shows the large table preview notice after pagination replaces the result (#12289)", async () => {
    const { host, replaceResult } = mountGrid(largeValueResult(1, "preview"));
    await settle();
    expect(host.querySelector("[data-grid-preview-notice]")).toBeTruthy();
    host.querySelector<HTMLElement>("[data-grid-preview-notice] button[title]")!.click();
    await settle();
    expect(host.querySelector("[data-grid-preview-notice]")).toBeNull();
    replaceResult(largeValueResult(1, "next-page"));
    await settle();
    expect(host.querySelector("[data-grid-preview-notice]")).toBeTruthy();
  });

  it("offers toolbar-equivalent refresh in the cell context menu (issue #7273)", async () => {
    const onReload = vi.fn();
    const { host } = mountGrid(hydratedResult(1, "value"), onReload);
    await settle();
    const cell = host.querySelector<HTMLElement>('[data-row-index="0"] [data-visible-col-index="1"]');
    if (!cell) throw new Error("Grid cell not found");
    openContextMenu(cell);
    await settle();
    // The item renders its label plus the Mod+R shortcut keys, so match by prefix.
    const refreshLabels = contextMenuLabels().filter((label) => label.startsWith("Refresh"));
    expect(refreshLabels.length).toBe(1);
    const refreshButton = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((button) => button.textContent?.trim().startsWith("Refresh"));
    refreshButton!.click();
    await settle();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("keeps the native context menu for the expanded condition editor", async () => {
    const { host } = mountGrid(hydratedResult(1, "abcdefghijklmnopqrstuvwxyz"));
    await settle();

    const input = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="WHERE"]');
    expect(input).not.toBeNull();
    input!.value = "abcdefghijklmnopqrstuvwxyz";
    input!.setSelectionRange(input!.value.length, input!.value.length);
    Object.defineProperties(input!, {
      clientWidth: { configurable: true, value: 80 },
      scrollWidth: { configurable: true, value: 320 },
      clientHeight: { configurable: true, value: 24 },
      scrollHeight: { configurable: true, value: 24 },
    });

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === input) return { x: 0, y: 0, left: 0, top: 0, right: 80, bottom: 24, width: 80, height: 24, toJSON: () => ({}) } as DOMRect;
      if (this instanceof HTMLSpanElement && this.style.position === "fixed") return { x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 24, width: 320, height: 24, toJSON: () => ({}) } as DOMRect;
      return originalGetBoundingClientRect.call(this);
    });

    try {
      input!.focus();
      input!.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      await settle();

      const expanded = document.body.querySelector<HTMLTextAreaElement>('.data-grid-topbar-condition-input--expanded[placeholder="WHERE"]');
      expect(expanded).not.toBeNull();

      const documentContextMenu = vi.fn((event: MouseEvent) => event.preventDefault());
      document.addEventListener("contextmenu", documentContextMenu);
      try {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 });
        expanded!.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(documentContextMenu).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener("contextmenu", documentContextMenu);
      }
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("preserves a newly opened header target and same-turn menu actions", async () => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    openContextMenu(columnHeader(host, 0));
    openContextMenu(columnHeader(host, 1));
    await settle();
    contextMenuButton("Copy Column Name").click();

    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("payload"));
  });

  it("copies column metadata from the header without reading row values", async () => {
    const { host } = mountGrid();
    openContextMenu(columnHeader(host, 1));
    await settle();
    contextMenuButton("Copy Column Metadata").click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("Name\tType\tSource\tNullable\tComment\npayload\ttext\tpayload\t\t"));
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("copies selected duplicate result aliases from a zero-row query without fetching data", async () => {
    const layoutScopeKey = "column-metadata-reordered-test";
    localStorage.setItem(`dbx-data-grid-column-layout:${layoutScopeKey}`, JSON.stringify({ version: 1, orderKeys: ["expression\u00000", "payload\u00001", "payload\u00000"], hiddenKeys: [] }));
    const result: QueryResult = {
      columns: ["id", "payload", "payload", "expression"],
      column_types: ["int", "text", "jsonb"],
      rows: [],
      affected_rows: 0,
      execution_time_ms: 0,
      hidden_column_indexes: [0],
    };
    const { host } = mountGrid(
      result,
      undefined,
      "postgres",
      {
        tableName: "events",
        primaryKeys: [],
        columns: [{ name: "payload", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "payload source" }],
      },
      layoutScopeKey,
    );
    await settle();
    const headers = [...host.querySelectorAll<HTMLElement>("[data-grid-column-index]")];
    expect(headers.map((header) => header.dataset.gridColumnIndex)).toEqual(["3", "2", "1"]);
    headers.forEach((header) => header.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    openContextMenu(headers.at(-1)!);
    await settle();
    contextMenuButton("Copy Column Metadata").click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("Name\tType\tSource\tNullable\tComment\nexpression\t\t\t\t\npayload\tjsonb\tpayload\tYES\tpayload source\npayload\ttext\tpayload\tYES\tpayload source"));
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("keeps SQL Select available in Copy as by default and restores it after hiding it", async () => {
    const { host, settingsStore } = mountGrid(hydratedResult(1, "value"));
    await settle();
    columnHeader(host, 1).click();
    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    expect(contextMenuLabels()).toContain("SQL Select");

    settingsStore.updateEditorSettings({ dataGridVisibleCopyExtractors: DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS.filter((item) => item !== "sql-select") });
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await settle();
    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    expect(contextMenuLabels()).not.toContain("SQL Select");

    contextMenuButton("Configure Data Extractors…").click();
    await settle();
    const restore = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Restore defaults");
    expect(restore).toBeTruthy();
    restore!.click();
    await settle();
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();
    expect(settingsStore.editorSettings.dataGridVisibleCopyExtractors).toContain("sql-select");
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await settle();
    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    expect(contextMenuLabels()).toContain("SQL Select");
  });

  it("copies the full current result using temporary advanced-copy options without saving settings", async () => {
    const rows = Array.from({ length: DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS + 2 }, (_, index) => [index + 1, `value-${index + 1}`]);
    const { host, settingsStore } = mountGrid({ columns: ["id", "payload"], rows, affected_rows: 0, execution_time_ms: 0 });
    await settle();
    selectAllHeader(host).click();
    openContextMenu(selectAllHeader(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    contextMenuButton("Advanced copy…").click();
    await settle();

    expect(mocks.extractDataGridSelection).not.toHaveBeenCalled();
    const php = document.querySelector<HTMLInputElement>('input[type="radio"][value="php"]');
    expect(php).toBeTruthy();
    php!.click();
    await settle();
    mocks.extractDataGridSelection.mockResolvedValueOnce({ text: "<?php return ['value'];", mimeType: "text/x-php", fileExtension: "php", rowCount: rows.length, columnCount: 1 });
    mocks.copyToClipboard.mockResolvedValueOnce(true);
    const copy = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "Copy").at(-1);
    expect(copy).toBeTruthy();
    expect(copy!.disabled).toBe(false);
    copy!.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("<?php return ['value'];"));
    const request = mocks.extractDataGridSelection.mock.calls[0]?.[0] as { rows: unknown[][]; extractor: string };
    expect(request.extractor).toBe("php");
    expect(request.rows).toHaveLength(DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS + 2);
    expect(request.rows[0]?.[0]).toBe(1);
    expect(request.rows.at(-1)?.[0]).toBe(DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS + 2);
    expect(settingsStore.editorSettings.dataGridCopyExtractor).toBe("smart");
  });

  it("does not write to the clipboard when the advanced-copy dialog closes during extraction", async () => {
    const pending = deferred<{ text: string; mimeType: string; fileExtension: string; rowCount: number; columnCount: number }>();
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();
    columnHeader(host, 1).click();
    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    contextMenuButton("Advanced copy…").click();
    await settle();
    mocks.extractDataGridSelection.mockReturnValueOnce(pending.promise);
    const copy = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "Copy").at(-1)!;
    copy.click();
    await vi.waitFor(() => expect(mocks.extractDataGridSelection).toHaveBeenCalledOnce());
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Cancel")!.click();
    await settle();
    pending.resolve({ text: "stale copy", mimeType: "text/plain", fileExtension: "txt", rowCount: 1, columnCount: 2 });
    await settle();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("invalidates advanced copy when the result changes during extraction", async () => {
    const pending = deferred<{ text: string; mimeType: string; fileExtension: string; rowCount: number; columnCount: number }>();
    const { host, replaceResult } = mountGrid(hydratedResult(1, "value"));
    await settle();
    columnHeader(host, 1).click();
    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    contextMenuButton("Advanced copy…").click();
    await settle();
    mocks.extractDataGridSelection.mockReturnValueOnce(pending.promise);
    const copy = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "Copy").at(-1)!;
    copy.click();
    await vi.waitFor(() => expect(mocks.extractDataGridSelection).toHaveBeenCalledOnce());
    replaceResult(hydratedResult(2, "updated"));
    await settle();
    pending.resolve({ text: "stale result", mimeType: "text/plain", fileExtension: "txt", rowCount: 1, columnCount: 2 });
    await settle();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("result or selection changed");
  });

  it("keeps clipboard success when the result changes after clipboard writing starts", async () => {
    const pendingClipboard = deferred<boolean>();
    const { host, replaceResult } = mountGrid(hydratedResult(1, "value"));
    await settle();
    columnHeader(host, 1).click();
    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    contextMenuButton("Advanced copy…").click();
    await settle();
    mocks.extractDataGridSelection.mockResolvedValueOnce({ text: "copied", mimeType: "text/plain", fileExtension: "txt", rowCount: 1, columnCount: 1 });
    mocks.copyToClipboard.mockReturnValueOnce(pendingClipboard.promise);
    const copy = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "Copy").at(-1)!;
    copy.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("copied"));

    replaceResult(hydratedResult(2, "updated"));
    await settle();
    pendingClipboard.resolve(true);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["result", "selection"] as const)("discards advanced-copy preview when the %s changes while it is pending", async (changed) => {
    const pendingPreview = deferred<{ text: string; mimeType: string; fileExtension: string; rowCount: number; columnCount: number; sourceRowCount: number; truncated: boolean }>();
    const { host, replaceResult } = mountGrid(hydratedResult(1, "value"));
    await settle();
    columnHeader(host, 1).click();
    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    contextMenuButton("Advanced copy…").click();
    await settle();
    mocks.extractDataGridSelection.mockReturnValueOnce(pendingPreview.promise);
    const previewToggle = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Preview"));
    expect(previewToggle).toBeTruthy();
    previewToggle!.click();
    await vi.waitFor(() => expect(mocks.extractDataGridSelection).toHaveBeenCalledOnce());

    if (changed === "result") replaceResult(hydratedResult(2, "updated"));
    else selectAllHeader(host).click();
    await settle();
    pendingPreview.resolve({ text: "stale preview", mimeType: "text/plain", fileExtension: "txt", rowCount: 1, columnCount: 1, sourceRowCount: 1, truncated: false });
    await settle();

    const preview = [...document.querySelectorAll<HTMLElement>("pre")].find((element) => element.textContent?.includes("result or selection changed"));
    expect(preview).toBeTruthy();
    expect(document.body.textContent).not.toContain("stale preview");
  });

  it("invalidates advanced copy when the selection changes during extraction", async () => {
    const pending = deferred<{ text: string; mimeType: string; fileExtension: string; rowCount: number; columnCount: number }>();
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();
    columnHeader(host, 1).click();
    openContextMenu(gridCell(host));
    await settle();
    contextMenuButton("Copy").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await settle();
    contextMenuButton("Advanced copy…").click();
    await settle();
    mocks.extractDataGridSelection.mockReturnValueOnce(pending.promise);
    const copy = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "Copy").at(-1)!;
    copy.click();
    await vi.waitFor(() => expect(mocks.extractDataGridSelection).toHaveBeenCalledOnce());
    selectAllHeader(host).click();
    await settle();
    pending.resolve({ text: "stale selection", mimeType: "text/plain", fileExtension: "txt", rowCount: 1, columnCount: 2 });
    await settle();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("result or selection changed");
  });

  it("keeps the initial select-all menu on the data selection target", async () => {
    const { host } = mountGrid(hydratedResult(1, "value"));
    await settle();

    selectAllHeader(host).click();
    openContextMenu(selectAllHeader(host));
    await settle();

    expect(contextMenuLabels()).toContain("Copy");
    expect(contextMenuLabels()).not.toContain("Copy Column Name");
  });
});

describe("DataGrid context filter lifecycle", () => {
  it("keeps the right-click target through menu close and large-value hydration", async () => {
    const hydration = deferred<QueryResult[]>();
    mockDeferredFullHydration(hydration.promise);
    const { host, onExecuteSql } = mountGrid();

    await startEqualsFilter(host);
    await vi.waitFor(() => expect(fullHydrationCallCount()).toBe(1));
    expect(document.querySelector("[data-dbx-context-menu]")).toBeNull();

    hydration.resolve([hydratedResult(1, "full original value")]);
    await vi.waitFor(() => expect(onExecuteSql).toHaveBeenCalledTimes(1));

    const sql = onExecuteSql.mock.calls[0]?.[0] as string;
    expect(sql).toContain("payload");
    expect(sql).toContain("full original value");
  });

  it("does not apply a completed hydration from a previous result set", async () => {
    const hydration = deferred<QueryResult[]>();
    mockDeferredFullHydration(hydration.promise);
    const { host, onExecuteSql, replaceResult } = mountGrid();

    await startEqualsFilter(host);
    await vi.waitFor(() => expect(fullHydrationCallCount()).toBe(1));
    replaceResult(largeValueResult(2, "new preview"));
    await settle();
    hydration.resolve([hydratedResult(1, "old value")]);
    await settle();

    expect(onExecuteSql).not.toHaveBeenCalled();
  });

  it("does not apply a delayed condition after the result set changes", async () => {
    const condition = deferred<string | undefined>();
    mocks.buildDataGridContextFilterCondition.mockReturnValue(condition.promise);
    const { host, onExecuteSql, replaceResult } = mountGrid(hydratedResult(1, "old value"));

    await startEqualsFilter(host);
    await vi.waitFor(() => expect(mocks.buildDataGridContextFilterCondition).toHaveBeenCalledTimes(1));
    replaceResult(hydratedResult(2, "new value"));
    await settle();
    condition.resolve("`payload` = 'old value'");
    await settle();

    expect(onExecuteSql).not.toHaveBeenCalled();
  });
});

describe("DataGrid visible large-value preview lifecycle", () => {
  it("invalidates a hydrated preview when paste edits the selected cell", async () => {
    mocks.executeMulti.mockImplementation((...args: unknown[]) => {
      const options = args[5] as { tableDataPreview?: boolean } | undefined;
      return Promise.resolve([hydratedResult(1, options?.tableDataPreview ? "visible preview" : "full value")]);
    });
    const { host } = mountGrid();

    await vi.waitFor(() => expect(gridCell(host).textContent).toContain("visible preview"));
    pasteGridCell(host, "edited value");

    await vi.waitFor(() => expect(gridCell(host).textContent).toContain("edited value"));
  });

  it("cancels a stale viewport request and starts the newest generation", async () => {
    const firstHydration = deferred<QueryResult[]>();
    let visibleRequestCount = 0;
    mocks.executeMulti.mockImplementation((...args: unknown[]) => {
      const options = args[5] as { tableDataPreview?: boolean } | undefined;
      if (!options?.tableDataPreview) return Promise.resolve([hydratedResult(1, "full value")]);
      visibleRequestCount += 1;
      return visibleRequestCount === 1 ? firstHydration.promise : Promise.resolve([hydratedResult(1, "latest preview")]);
    });
    mocks.cancelQuery.mockImplementation(async () => {
      firstHydration.reject(new Error("cancelled"));
      return true;
    });
    const { host } = mountGrid();

    await vi.waitFor(() => expect(visibleHydrationCalls()).toHaveLength(1));
    const firstExecutionId = visibleHydrationCalls()[0]?.[4];
    const scroller = host.querySelector<HTMLElement>(".data-grid-scroller");
    if (!scroller) throw new Error("Data grid scroller not found");
    scroller.scrollTop = 26;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.cancelQuery).toHaveBeenCalledWith(firstExecutionId));
    await vi.waitFor(() => expect(visibleHydrationCalls()).toHaveLength(2));
    expect(visibleHydrationCalls()[1]?.[4]).not.toBe(firstExecutionId);
  });

  it("does not cache a visible preview completed after the cell is edited", async () => {
    const hydration = deferred<QueryResult[]>();
    mocks.executeMulti.mockImplementation((...args: unknown[]) => {
      const options = args[5] as { tableDataPreview?: boolean } | undefined;
      return options?.tableDataPreview ? hydration.promise : Promise.resolve([hydratedResult(1, "full value")]);
    });
    const { host } = mountGrid();

    await vi.waitFor(() => expect(visibleHydrationCalls()).toHaveLength(1));
    pasteGridCell(host, "edited during hydration");
    await vi.waitFor(() => expect(gridCell(host).textContent).toContain("edited during hydration"));

    hydration.resolve([hydratedResult(1, "stale visible preview")]);
    await settle();

    expect(gridCell(host).textContent).toContain("edited during hydration");
    expect(gridCell(host).textContent).not.toContain("stale visible preview");
  });

  it("invalidates hydrated previews across undo, scroll, and redo", async () => {
    let visibleRequestCount = 0;
    mocks.executeMulti.mockImplementation((...args: unknown[]) => {
      const options = args[5] as { tableDataPreview?: boolean } | undefined;
      if (!options?.tableDataPreview) return Promise.resolve([hydratedResult(1, "full value")]);
      visibleRequestCount += 1;
      return Promise.resolve([hydratedResult(1, visibleRequestCount === 1 ? "initial visible preview" : "undo visible preview")]);
    });
    const { host } = mountGrid();

    await vi.waitFor(() => expect(gridCell(host).textContent).toContain("initial visible preview"));
    pasteGridCell(host, "edited value");
    await vi.waitFor(() => expect(gridCell(host).textContent).toContain("edited value"));

    const gridRoot = host.querySelector<HTMLElement>("[data-grid-root]");
    const scroller = host.querySelector<HTMLElement>(".data-grid-scroller");
    if (!gridRoot || !scroller) throw new Error("Data grid controls not found");
    gridRoot.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z" }));
    await settle();
    scroller.scrollTop = 26;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

    await vi.waitFor(() => expect(gridCell(host).textContent).toContain("undo visible preview"));
    gridRoot.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, shiftKey: true, key: "z" }));

    await vi.waitFor(() => expect(gridCell(host).textContent).toContain("edited value"));
    expect(gridCell(host).textContent).not.toContain("undo visible preview");
  });

  it("does not start a stale query after deferred SQL construction and scrolling", async () => {
    const firstBuild = deferred<string>();
    mocks.buildTableSelectSql.mockImplementationOnce(() => firstBuild.promise).mockResolvedValueOnce("SELECT latest preview");
    mocks.executeMulti.mockResolvedValue([hydratedResult(1, "latest visible preview")]);
    const { host } = mountGrid();

    await vi.waitFor(() => expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(1));
    const scroller = host.querySelector<HTMLElement>(".data-grid-scroller");
    if (!scroller) throw new Error("Data grid scroller not found");
    scroller.scrollTop = 26;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(visibleHydrationCalls()).toHaveLength(1));

    firstBuild.resolve("SELECT stale preview");
    await settle();

    expect(visibleHydrationCalls()).toHaveLength(1);
    expect(visibleHydrationCalls()[0]?.[2]).toBe("SELECT latest preview");
  });

  it("does not start a stale query after deferred SQL construction and unmount", async () => {
    const build = deferred<string>();
    mocks.buildTableSelectSql.mockImplementationOnce(() => build.promise);
    const { unmount } = mountGrid();

    await vi.waitFor(() => expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(1));
    unmount();
    build.resolve("SELECT stale preview");
    await settle();

    expect(visibleHydrationCalls()).toHaveLength(0);
  });
});

describe("DataGrid DOM initial scroll position", () => {
  it("keeps the first row visible while the virtual list finishes measuring", async () => {
    const { host, replaceResult } = mountGrid(hydratedResult(1, "value"));
    await settle();

    const scroller = host.querySelector<HTMLElement>(".data-grid-scroller");
    if (!scroller) throw new Error("Data grid scroller not found");
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollWidth: { configurable: true, value: 1200 },
      clientWidth: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: {
        configurable: true,
        get: () => (scroller.classList.contains("has-horizontal-scrollbar") ? 2600 : 500),
      },
    });

    replaceResult({
      columns: ["id", "payload"],
      rows: Array.from({ length: 100 }, (_, index) => [index + 1, `row-${index + 1}`]),
      affected_rows: 0,
      execution_time_ms: 0,
    });
    await settle();

    expect(scroller.classList.contains("has-horizontal-scrollbar")).toBe(true);
    expect(scroller.scrollTop).toBe(0);
  });
});
