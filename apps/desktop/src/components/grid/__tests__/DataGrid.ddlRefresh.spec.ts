// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearMetadataRuntimeCache } from "@/lib/metadata/metadataRuntimeCache";
import { invalidateObjectDdlCache, loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import type { DataGridToolbarActionCapability } from "@/lib/dataGrid/dataGridToolbar";
import type { DatabaseType, QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  getTableDisplayDdl: vi.fn(),
  persisted: new Map<string, unknown>(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  getTableDisplayDdl: mocks.getTableDisplayDdl,
  listIndexes: async () => [],
  saveEditorSettings: async () => undefined,
  loadSchemaCache: async (key: string) => mocks.persisted.get(key) ?? null,
  saveSchemaCache: async (key: string, value: unknown) => {
    mocks.persisted.set(key, value);
  },
  deleteSchemaCachePrefix: async (prefix: string) => {
    for (const key of mocks.persisted.keys()) if (key.startsWith(prefix)) mocks.persisted.delete(key);
  },
}));

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/composables/useDataGridColumnResize")>()),
  useDataGridColumnResize: () => ({
    initColumnWidths: vi.fn(),
    onResizeStart: vi.fn(),
    autoFitColumn: vi.fn(),
    renderedColumnWidths: ref([120]),
    totalWidth: ref(120),
    columnVars: ref({ "--total-w": "120px" }),
    getIsResizing: () => false,
  }),
}));

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const request = { connectionId: "ddl-refresh", database: "app", schema: "app", tableName: "users" };
const originalDdl = "CREATE TABLE users (id INT);";
const changedDdl = "CREATE TABLE users (id INT, external_added VARCHAR(64));";
const mountedApps: App[] = [];

function mountGrid(databaseType: DatabaseType = "mysql") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.updateEditorSettings({ dataGridRenderMode: "canvas", tableInfoActiveTab: "ddl", refreshDdlOnOpen: false });
  const result = ref(markRaw<QueryResult>({ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 0 }));
  const tableMeta = ref({ tableName: request.tableName, schema: request.schema, columns: [], primaryKeys: [] });
  const reload = vi.fn(() => {
    // The parent rebuilds table metadata on a manual data refresh, even for the same table.
    tableMeta.value = { ...tableMeta.value, columns: [] };
    result.value = markRaw({ ...result.value, rows: [[2]] });
  });
  const grid = ref<{ tableInfoToolbarCapability: DataGridToolbarActionCapability; onToolbarRefresh: () => Promise<void> }>();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(
        TooltipProvider,
        { delayDuration: 0 },
        {
          default: () =>
            h(DataGrid, {
              ref: grid,
              result: result.value,
              tableMeta: tableMeta.value,
              onReload: reload,
              databaseType,
              context: "table-data",
              connectionId: request.connectionId,
              database: request.database,
            }),
        },
      ),
  });
  app.use(pinia);
  app.use(i18n);
  app.component(
    "RecycleScroller",
    defineComponent({
      props: ["items"],
      setup(props, { slots }) {
        return () =>
          h(
            "div",
            props.items?.map((item: unknown) => slots.default?.({ item })),
          );
      },
    }),
  );
  app.mount(host);
  mountedApps.push(app);
  const ddlText = () => host.querySelector("[data-table-info-drawer] pre")?.textContent ?? "";
  const toggleDdl = () => grid.value!.tableInfoToolbarCapability.onTrigger();
  return { host, grid, result, reload, ddlText, toggleDdl };
}

beforeEach(async () => {
  await invalidateObjectDdlCache({});
  clearMetadataRuntimeCache();
  mocks.persisted.clear();
  mocks.getTableDisplayDdl.mockReset().mockResolvedValue(originalDdl);
});

afterEach(async () => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  await invalidateObjectDdlCache({});
  clearMetadataRuntimeCache();
});

it.each([
  ["mysql", "memory"],
  ["mysql", "disk"],
  ["starrocks", "memory"],
] as const)("opens fresh %s DDL despite an old %s snapshot and refresh-on-open being disabled", async (databaseType, cache) => {
  await loadObjectDdl(request);
  if (cache === "disk") clearMetadataRuntimeCache();
  mocks.getTableDisplayDdl.mockResolvedValue(changedDdl);
  const { ddlText, toggleDdl } = mountGrid(databaseType);
  toggleDdl();
  await vi.waitFor(() => expect(ddlText()).toContain("external_added"));
  expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
});

it("reloads DDL when reopening the drawer and when clicking its refresh button", async () => {
  const { host, ddlText, toggleDdl } = mountGrid();
  toggleDdl();
  await vi.waitFor(() => expect(ddlText()).toContain("CREATE TABLE"));
  toggleDdl();
  await nextTick();
  mocks.getTableDisplayDdl.mockResolvedValue(changedDdl);
  toggleDdl();
  await vi.waitFor(() => expect(ddlText()).toContain("external_added"));

  mocks.getTableDisplayDdl.mockResolvedValue("CREATE TABLE users (id INT, another_external INT);");
  const drawer = host.querySelector("[data-table-info-drawer]")!;
  const search = drawer.querySelector("[data-table-info-search]")!;
  const refresh = search.parentElement!.parentElement!.querySelector<HTMLButtonElement>("button[aria-label]");
  expect(refresh).not.toBeNull();
  refresh!.click();
  await vi.waitFor(() => expect(ddlText()).toContain("another_external"));
  expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(3);
});

it("refreshes visible DDL without delaying the main data refresh for metadata", async () => {
  const { grid, result, reload, ddlText, toggleDdl } = mountGrid();
  toggleDdl();
  await vi.waitFor(() => expect(ddlText()).toContain("CREATE TABLE"));
  let resolveDdl!: (ddl: string) => void;
  mocks.getTableDisplayDdl.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      resolveDdl = resolve;
    }),
  );
  let refreshed = false;
  const refresh = grid.value!.onToolbarRefresh().then(() => {
    refreshed = true;
  });
  try {
    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledOnce();
      expect(refreshed).toBe(true);
      expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
    });
    expect(result.value.rows).toEqual([[2]]);
  } finally {
    resolveDdl(changedDdl);
  }
  await refresh;
  await vi.waitFor(() => expect(ddlText()).toContain("external_added"));
});
