// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  buildDataGridContextFilterCondition: vi.fn(async ({ columnName, value }: { columnName: string; value: unknown }) => `\`${columnName}\` = '${String(value)}'`),
  buildTableSelectSql: vi.fn(async ({ whereInput }: { whereInput?: string }) => `SELECT payload FROM events${whereInput ? ` WHERE ${whereInput}` : ""}`),
  executeMulti: vi.fn(),
  cancelQuery: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  buildDataGridContextFilterCondition: mocks.buildDataGridContextFilterCondition,
  buildTableSelectSql: mocks.buildTableSelectSql,
  executeMulti: mocks.executeMulti,
  cancelQuery: mocks.cancelQuery,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
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

function mountGrid(initialResult = largeValueResult()) {
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
                databaseType: "mysql",
                connectionId: "connection-1",
                database: "dbx",
                context: "table-data",
                editable: true,
                tableMeta: {
                  tableName: "events",
                  columns: [
                    { name: "id", data_type: "int" },
                    { name: "payload", data_type: "text" },
                  ],
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
  app.component("RecycleScroller", RecycleScroller);
  app.mount(host);
  // Mount once with the production-default Canvas mode so DataGrid finishes
  // setting up its column-width dependencies, then exercise the DOM grid.
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  const mounted = { app, host };
  mountedApps.push(mounted);
  return {
    host,
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
