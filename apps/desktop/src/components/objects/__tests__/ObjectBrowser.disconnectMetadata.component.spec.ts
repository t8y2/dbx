// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";
import ObjectBrowser from "../ObjectBrowser.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ConnectionConfig } from "@/types/database";

const api = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn().mockResolvedValue(["APP"]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  disconnectDb: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  saveConnections: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/backend/api", () => api);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined, global: { t: (key: string) => key } } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
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
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { render: () => null } }));
vi.mock("@/components/ui/ToolbarOverflowMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

it("retires an actual ObjectBrowser page when the real store disconnects the same connection", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  const settings = useSettingsStore();
  settings.editorSettings.disconnectTabHandlingMode = "keep-tabs-clear-results";
  const connection = { id: "ob-real-generation", name: "OB", db_type: "oceanbase-oracle", database: "APP", transport_layers: [] } as unknown as ConnectionConfig;
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  let resolve!: (rows: unknown[]) => void;
  api.listObjects.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "APP", schema: "APP", selectedObjectFilter: "all" }) });
  app.use(pinia);
  try {
    app.mount(host);
    await vi.waitFor(() => expect(api.listObjects).toHaveBeenCalled());
    await store.disconnect(connection.id);
    resolve([{ name: "STALE_AFTER_DISCONNECT", schema: "APP", object_type: "TABLE" }]);
    await new Promise((done) => setTimeout(done, 10));
    expect(host.textContent).not.toContain("STALE_AFTER_DISCONNECT");
  } finally {
    app.unmount();
    host.remove();
  }
});

it("cancels a pending object search when the real store disconnects", async () => {
  vi.useFakeTimers();
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  useSettingsStore().editorSettings.disconnectTabHandlingMode = "keep-tabs-clear-results";
  const connection = { id: "ob-pending-search", name: "OB", db_type: "oceanbase-oracle", database: "APP", transport_layers: [] } as unknown as ConnectionConfig;
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  api.listObjects.mockReset().mockResolvedValue([]);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "APP", schema: "APP", selectedObjectFilter: "all" }) });
  app.use(pinia);
  try {
    app.mount(host);
    await vi.waitFor(() => expect(api.listObjects).toHaveBeenCalledTimes(1));
    const input = host.querySelector<HTMLInputElement>("[data-object-search-input]")!;
    input.value = "PENDING_SEARCH";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await store.disconnect(connection.id);
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    expect(api.listObjects).toHaveBeenCalledTimes(1);
  } finally {
    app.unmount();
    host.remove();
    vi.useRealTimers();
  }
});
