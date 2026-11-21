// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { listObjects } from "@/lib/backend/api";
import type { ConnectionConfig } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listSchemas: vi.fn().mockResolvedValue(["public", "other"]),
  listObjects: vi.fn().mockResolvedValue([
    { name: "orders", object_type: "TABLE", schema: "public" },
    { name: "orders_bak", object_type: "TABLE", schema: "public" },
    { name: "bak_orders", object_type: "TABLE", schema: "public" },
  ]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
}));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: ["items"],
    setup:
      (props, { slots }) =>
      () =>
        h(
          "div",
          props.items.map((item: unknown) => slots.default?.({ item })),
        ),
  }),
}));

let app: App;
let pinia: ReturnType<typeof createPinia>;
let host: HTMLElement;

beforeEach(() => {
  invalidateObjectBrowserRowsCache({});
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.restoreAllMocks();
  invalidateObjectBrowserRowsCache({});
  localStorage.clear();
});

const connection = { id: "filter-13599", name: "HighGo", db_type: "highgo", database: "app", driver_profile: null, transport_layers: [] } as unknown as ConnectionConfig;

async function mountBrowser(config = connection, selectedObjectFilter?: "all" | "tables", readySelector = '[title="orders"]') {
  const store = useConnectionStore();
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  useSettingsStore().editorSettings.objectBrowserViewMode = "list";
  const props = reactive({ connection: config, database: "app", schema: "public", selectedObjectFilter, catalog: undefined as string | undefined });
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(ObjectBrowser, props) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector(readySelector)).not.toBeNull());
  return props;
}

it("applies the sidebar name filter to the right-hand browser and reacts to clearing it (#13599)", async () => {
  const store = useConnectionStore();
  const scope = { connectionId: connection.id, database: "app", schema: "public", nodeKind: "group-tables" };
  store.setSidebarTableNameFilter(store.tableNameFilterScopeKey(scope), { includePatterns: [], excludePatterns: ["%_bak", "bak_%"] });
  await mountBrowser();
  expect(host.querySelector('[title="orders_bak"]')).toBeNull();
  expect(host.querySelector('[title="bak_orders"]')).toBeNull();
  expect(host.querySelector("[data-object-filter-count]")?.textContent?.trim()).toBe("objects.tables 1");

  const search = host.querySelector<HTMLInputElement>("[data-object-search-input]")!;
  search.value = "bak";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(host.querySelector('[title="orders_bak"]')).toBeNull();
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));

  app.unmount();
  host.remove();
  await mountBrowser();
  expect(host.querySelector('[title="orders_bak"]')).toBeNull();
  store.setSidebarTableNameFilter(store.tableNameFilterScopeKey(scope), { includePatterns: [], excludePatterns: [] });
  await nextTick();
  expect(host.querySelector('[title="orders_bak"]')).not.toBeNull();
  expect(host.querySelector('[title="bak_orders"]')).not.toBeNull();
  expect(host.querySelector("[data-object-filter-count]")?.textContent?.trim()).toBe("objects.tables 3");
});

it("isolates filters by object kind, schema, catalog and connection", async () => {
  const store = useConnectionStore();
  const scope = { connectionId: connection.id, database: "app", schema: "public" };
  store.setSidebarTableNameFilter(store.tableNameFilterScopeKey(scope), { includePatterns: ["orders"], excludePatterns: [] });
  vi.mocked(listObjects).mockResolvedValueOnce([
    { name: "orders", object_type: "TABLE", schema: "public" },
    { name: "orders_bak", object_type: "TABLE", schema: "public" },
    { name: "orders_view", object_type: "VIEW", schema: "public" },
  ]);
  const mixedProps = await mountBrowser(connection, "all");
  expect(host.querySelector('[title="orders_bak"]')).toBeNull();
  expect(host.querySelector('[title="orders_view"]')).not.toBeNull();
  store.setSidebarTableNameFilter(store.tableNameFilterScopeKey({ ...scope, nodeKind: "group-views" }), { includePatterns: [], excludePatterns: ["%view"] });
  await nextTick();
  expect(host.querySelector('[title="orders_view"]')).toBeNull();

  mixedProps.schema = "other";
  await vi.waitFor(() => expect(host.querySelector('[title="orders_bak"]')).not.toBeNull());
  mixedProps.schema = "public";
  await vi.waitFor(() => expect(host.querySelector('[title="orders_bak"]')).toBeNull());
  mixedProps.catalog = "other-catalog";
  await vi.waitFor(() => expect(host.querySelector('[title="orders_bak"]')).not.toBeNull());
  mixedProps.catalog = undefined;
  mixedProps.connection = { ...connection, id: "other-connection" };
  await vi.waitFor(() => expect(host.querySelector('[title="orders_bak"]')).not.toBeNull());
});

it("keeps loading more available when an entire server page is excluded", async () => {
  const config = { ...connection, db_type: "oceanbase-oracle" } as ConnectionConfig;
  const store = useConnectionStore();
  store.setSidebarTableNameFilter(store.tableNameFilterScopeKey({ connectionId: config.id, database: "app", schema: "public" }), { includePatterns: [], excludePatterns: ["bak_%"] });
  useSettingsStore().desktopSettings.sidebar_table_page_size = 2;
  vi.mocked(listObjects)
    .mockResolvedValueOnce([
      { name: "bak_one", object_type: "TABLE", schema: "public" },
      { name: "bak_two", object_type: "TABLE", schema: "public" },
      { name: "orders", object_type: "TABLE", schema: "public" },
    ])
    .mockResolvedValueOnce([{ name: "orders", object_type: "TABLE", schema: "public" }]);
  await mountBrowser(config, "tables", "[data-object-load-more]");
  expect(host.querySelector('[title="bak_one"]')).toBeNull();
  expect(host.querySelector('[title="bak_two"]')).toBeNull();
  host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
  await vi.waitFor(() => expect(host.querySelector('[title="orders"]')).not.toBeNull());
  expect(vi.mocked(listObjects).mock.calls.at(-1)?.[6]).toBe(2);
  expect(host.querySelector("[data-object-load-more]")).toBeNull();
});
