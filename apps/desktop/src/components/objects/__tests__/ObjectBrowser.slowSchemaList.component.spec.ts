// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";
import { filterSchemaNamesForConnection, schemaVisibilityDatabaseKey } from "@/lib/database/visibleDatabases";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  ensureConnected: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => connection,
    completionCacheRevision: () => schemaChoicesRevision.value,
    ensureConnected: mocks.ensureConnected,
    readVisibleSchemaSelection: async (id: string, database: string) => ({ visibleNames: filterSchemaNamesForConnection(await mocks.listSchemas(id, database, false, true), activeConnection, schemaVisibilityDatabaseKey(activeConnection, database)) }),
    tableNameFilterForScope: () => undefined,
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
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: defineComponent({ props: ["options", "modelValue"], setup: (props) => () => h("output", { "data-schema-options": JSON.stringify(props.options), "data-schema-target": props.modelValue }) }) }));
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
  id: "dameng-slow-schemas",
  name: "Dameng",
  db_type: "dameng",
  database: "TEST",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];
const schemaChoicesRevision = ref(0);
let activeConnection = connection;

beforeEach(() => {
  vi.clearAllMocks();
  schemaChoicesRevision.value = 0;
  mocks.listObjects.mockImplementation(async (...args: unknown[]) => (args[10] === true ? [] : [{ name: "TEST2026", object_type: "TABLE" }]));
  mocks.ensureConnected.mockResolvedValue(undefined);
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser(config = connection, database = "TEST", schema = "TEST") {
  activeConnection = config;
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection: config, database, schema }) });
  mountedApps.push({ app, host });
  app.mount(host);
  return host;
}

describe("ObjectBrowser with a slow schema list", () => {
  it("refreshes newly discovered ordinary choices when overrides remain empty without switching the open target", async () => {
    const config = reactive({ ...connection, schema_visibility: { migrate_legacy: false, databases: { TEST: {} } } });
    mocks.listSchemas.mockReset().mockResolvedValueOnce(["APP"]).mockResolvedValue(["APP", "NEW_APP"]);
    const host = await mountBrowser(config, "APP", "APP");
    const options = () => host.querySelector("[data-schema-options]")?.getAttribute("data-schema-options");
    await vi.waitFor(() => expect(options()).toBe('["APP"]'));
    const objectLoads = mocks.listObjects.mock.calls.length;
    schemaChoicesRevision.value++;
    await vi.waitFor(() => expect(options()).toBe('["APP","NEW_APP"]'));
    expect(host.querySelector("[data-schema-target]")?.getAttribute("data-schema-target")).toBe("APP");
    expect(mocks.listObjects).toHaveBeenCalledTimes(objectLoads);
  });
  it("rejects old candidate responses after the current scope changes again", async () => {
    let complete!: (names: string[]) => void;
    mocks.listSchemas
      .mockReset()
      .mockResolvedValueOnce(["APP", "SYS"])
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(["APP", "SYS"]);
    const config = reactive({ ...connection, visible_schemas: { TEST: ["APP"] } });
    const host = await mountBrowser(config, "APP", "APP");
    const options = () => host.querySelector("[data-schema-options]")?.getAttribute("data-schema-options");
    await vi.waitFor(() => expect(options()).toBe('["APP"]'));
    config.visible_schemas = { TEST: ["SYS"] };
    await nextTick();
    await vi.waitFor(() => expect(mocks.listSchemas).toHaveBeenCalledTimes(2));
    config.visible_schemas = { TEST: ["APP"] };
    await nextTick();
    await vi.waitFor(() => expect(mocks.listSchemas).toHaveBeenCalledTimes(3));
    complete(["SYS"]);
    await nextTick();
    await Promise.resolve();
    expect(options()).toBe('["APP"]');
    expect(host.querySelector("[data-schema-target]")?.getAttribute("data-schema-target")).toBe("APP");
  });
  it("updates explicitly selected system candidates using the root bucket without switching the open object target", async () => {
    const config = reactive({ ...connection, show_system_schemas: false, visible_schemas: { TEST: ["APP"] } });
    mocks.listSchemas.mockImplementation(async (_id, _database, _filter, system) => (system ? ["APP", "SYS"] : ["APP"]));
    const host = await mountBrowser(config, "APP", "APP");
    const options = () => host.querySelector("[data-schema-options]")?.getAttribute("data-schema-options");
    await vi.waitFor(() => expect(options()).toBe('["APP"]'));
    const objectLoads = mocks.listObjects.mock.calls.length;
    config.visible_schemas = { TEST: ["SYS"] };
    await vi.waitFor(() => expect(options()).toBe('["SYS"]'));
    expect(mocks.listSchemas).toHaveBeenLastCalledWith(connection.id, "APP", false, true);
    expect(host.querySelector("[data-schema-target]")?.getAttribute("data-schema-target")).toBe("APP");
    expect(mocks.listObjects).toHaveBeenCalledTimes(objectLoads);
    config.visible_schemas = { TEST: [] };
    await vi.waitFor(() => expect(options()).toBe("[]"));
    const schemaLoads = mocks.listSchemas.mock.calls.length;
    config.visible_schemas = { TEST: [], archive: ["HISTORY"] } as Record<string, string[]>;
    await nextTick();
    expect(mocks.listSchemas).toHaveBeenCalledTimes(schemaLoads);
    expect(host.querySelector("[data-schema-target]")?.getAttribute("data-schema-target")).toBe("APP");
  });
  it("loads the object list without waiting for listSchemas (#8665)", async () => {
    // listSchemas 一直不返回，模拟达梦扫描庞大 SYS.SYSOBJECTS 的场景。
    mocks.listSchemas.mockReturnValue(new Promise<string[]>(() => {}));

    const host = await mountBrowser();

    await vi.waitFor(() => expect(host.textContent).toContain("TEST2026"));
    // Schema index metadata is read only in the dedicated paged filter.
    expect(mocks.listObjects).toHaveBeenCalledWith("dameng-slow-schemas", "TEST", "TEST", expect.arrayContaining(["TABLE", "VIEW", "TRIGGER"]), undefined, undefined, undefined, undefined, undefined, undefined, { identityMode: "exact" });
    expect(mocks.listObjects.mock.calls[0][3]).not.toContain("INDEX");
    expect(mocks.listObjects).toHaveBeenCalledTimes(1);
    expect(mocks.listSchemas).toHaveBeenCalledWith("dameng-slow-schemas", "TEST", false, true);
    expect(host.textContent).not.toContain("objects.empty");
  });

  it("still applies the schema list once a slow listSchemas resolves", async () => {
    let resolveSchemas: (names: string[]) => void = () => undefined;
    mocks.listSchemas.mockReturnValue(new Promise<string[]>((resolve) => (resolveSchemas = resolve)));

    const host = await mountBrowser();
    await vi.waitFor(() => expect(host.textContent).toContain("TEST2026"));

    resolveSchemas(["TEST", "OTHER"]);
    await Promise.resolve();
    await nextTick();
    expect(mocks.listObjects).toHaveBeenCalledTimes(1);
  });
});
