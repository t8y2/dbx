// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";

const backend = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(async () => []),
  listObjectStatistics: vi.fn(async () => []),
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(async (input: { source: string }) => input.source),
  checkConnectionHealth: vi.fn(async () => undefined),
  saveOpenTabsState: vi.fn(async () => undefined),
  loadOpenTabsState: vi.fn(async () => ({ tabs: [], activeTabId: null })),
  executeQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(async () => true),
  listDetachedTabHandoffs: vi.fn(async () => []),
  subscribeConnectionLiveness: vi.fn(async () => () => {}),
  subscribeConnectionIdleClosed: vi.fn(async () => () => {}),
  invalidType: "TYPE",
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...backend }));
vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/components/objects/OracleInvalidObjectsDialog.vue", () => ({
  default: defineComponent({
    props: { open: Boolean },
    emits: ["open-source", "update:open"],
    setup(props, { emit }) {
      return () => (props.open ? h("button", { "data-repair-source": "", onClick: () => emit("open-source", { owner: "APP", name: "T_BAD", type: backend.invalidType }) }, "repair source") : null);
    },
  }),
}));
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
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));

const connection = { id: "invalid-type-source", name: "Oracle test", db_type: "oracle", host: "localhost", port: 1521, username: "APP", password: "" } as ConnectionConfig;
let pinia: Pinia;
let app: App;
let host: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [connection];
  connections.connectedIds.add(connection.id);
  invalidateObjectBrowserRowsCache({});
});
afterEach(() => {
  app?.unmount();
  host?.remove();
  disposePinia(pinia);
  setActivePinia(undefined);
  invalidateObjectBrowserRowsCache({});
});

describe("invalid TYPE repair through the real object browser and source store", () => {
  it.each([
    ["TYPE", "TYPE"],
    ["TYPE BODY", "TYPE_BODY"],
  ] as const)("opens %s in controlled source editing instead of a generic runnable SQL tab", async (dictionaryType, objectType) => {
    backend.invalidType = dictionaryType;
    const source = `CREATE OR REPLACE ${dictionaryType} APP.T_BAD AS ${objectType === "TYPE" ? "OBJECT (ID NUMBER)" : "MEMBER FUNCTION F RETURN NUMBER AS BEGIN RETURN NO_FIELD; END; END"};`;
    backend.listObjects.mockResolvedValue([{ name: "T_BAD", schema: "APP", object_type: objectType }]);
    backend.getObjectSource.mockResolvedValue({ name: "T_BAD", object_type: objectType, source, editable: true });
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "ORCL", schema: "APP" }) });
    app.use(pinia).mount(host);
    await vi.waitFor(() => expect(host.textContent).toContain("T_BAD"));
    const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"));
    expect(open).toBeDefined();
    open!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-repair-source]")!.click();
    const store = useQueryStore();
    await vi.waitFor(() => expect(store.tabs).toHaveLength(1));
    await vi.waitFor(() => expect(store.tabs[0].sourceLoad).toBeUndefined());
    const tab = store.tabs[0];
    expect(tab.objectSource).toMatchObject({ schema: "APP", name: "T_BAD", objectType });
    expect(tab.objectDetails).toMatchObject({ schema: "APP", name: "T_BAD", objectType, section: "source" });
    expect(tab.typeSourceEditing).toBe(true);
    expect(tab.sourceView).toBe(true);
    expect(tab.sql).toBe(source);
    await expect(store.executeTabSql(tab.id, source)).rejects.toThrow();
    expect(backend.executeQuery).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(host.querySelector("[data-repair-source]")).toBeNull());
  });
});
