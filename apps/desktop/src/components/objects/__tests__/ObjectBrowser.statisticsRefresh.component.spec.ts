// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { cacheObjectBrowserRows, createObjectBrowserRowsCacheWriteToken, invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  listObjectStatistics: vi.fn(),
  ensureConnected: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: (...args: unknown[]) => mocks.listObjectStatistics(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => connection,
    ensureConnected: mocks.ensureConnected,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: "list",
      objectBrowserShowCheckbox: false,
      sidebarCopyTableNameSeparator: "newline",
      sidebarCopyTableNameIncludeSchema: false,
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          props.items.map((item) => slots.default?.({ item })),
        );
    },
  }),
}));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { render: () => null } }));
vi.mock("@/components/ui/ToolbarOverflowMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.({ onContextMenu: () => undefined, isOpen: false });
    },
  }),
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = {
  id: "pg-stale-statistics",
  name: "Postgres",
  db_type: "postgres",
  database: "pgdemo",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const scope = { connectionId: connection.id, database: "pgdemo", schema: "public" };
const cachedRows: ObjectBrowserRow[] = [
  {
    id: "table:orders",
    name: "orders",
    displayName: "orders",
    type: "TABLE",
    schema: "public",
    estimatedRows: 0,
    totalBytes: 24_576,
  },
];

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listObjects.mockResolvedValue([{ name: "orders", object_type: "TABLE" }]);
  mocks.listSchemas.mockResolvedValue(["public"]);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listObjectStatistics.mockResolvedValue([{ name: "orders", schema: "public", estimated_rows: 901, total_bytes: 196_608 }]);
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "pgdemo", schema: "public" }) });
  mountedApps.push({ app, host });
  app.mount(host);
  return host;
}

function primeRowsCache(cachedAt: number) {
  cacheObjectBrowserRows(createObjectBrowserRowsCacheWriteToken(scope), cachedRows, { cachedAt });
}

describe("ObjectBrowser table statistics on a cached scaffold (#10461)", () => {
  it("backfills row/size statistics when the restored scaffold is stale", async () => {
    primeRowsCache(Date.now() - 31_000);

    const host = await mountBrowser();

    // 行数/大小 随对象列表一起缓存，陈旧条目必须在后台补一次统计。
    await vi.waitFor(() => expect(mocks.listObjectStatistics).toHaveBeenCalledWith("pg-stale-statistics", "pgdemo", "public"));
    await vi.waitFor(() => expect(host.textContent).toContain("901"));
    expect(host.textContent).toContain("192 KB");
    // 陈旧缓存仍然直接渲染，且不重新拉对象列表。
    expect(mocks.listObjects).not.toHaveBeenCalled();
  });

  it("leaves a fresh scaffold alone so tab switches stay quiet", async () => {
    primeRowsCache(Date.now());

    const host = await mountBrowser();

    await vi.waitFor(() => expect(host.textContent).toContain("orders"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.listObjectStatistics).not.toHaveBeenCalled();
    expect(mocks.listObjects).not.toHaveBeenCalled();
  });
});
