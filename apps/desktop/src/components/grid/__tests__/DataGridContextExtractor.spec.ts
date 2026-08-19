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
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  buildDataGridContextFilterCondition: mocks.buildDataGridContextFilterCondition,
  buildTableSelectSql: mocks.buildTableSelectSql,
  executeMulti: mocks.executeMulti,
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
  mountedApps.push({ app, host });
  return { host, onExecuteSql, replaceResult: (nextResult: QueryResult) => (result.value = markRaw(nextResult)) };
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
    mocks.executeMulti.mockReturnValue(hydration.promise);
    const { host, onExecuteSql } = mountGrid();

    await startEqualsFilter(host);
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(1));
    expect(document.querySelector("[data-dbx-context-menu]")).toBeNull();

    hydration.resolve([hydratedResult(1, "full original value")]);
    await vi.waitFor(() => expect(onExecuteSql).toHaveBeenCalledTimes(1));

    const sql = onExecuteSql.mock.calls[0]?.[0] as string;
    expect(sql).toContain("payload");
    expect(sql).toContain("full original value");
  });

  it("does not apply a completed hydration from a previous result set", async () => {
    const hydration = deferred<QueryResult[]>();
    mocks.executeMulti.mockReturnValue(hydration.promise);
    const { host, onExecuteSql, replaceResult } = mountGrid();

    await startEqualsFilter(host);
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(1));
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
