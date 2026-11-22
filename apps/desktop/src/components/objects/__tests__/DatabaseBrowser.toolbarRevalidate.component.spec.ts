// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listDatabases: vi.fn(),
  listDatabaseMetadata: vi.fn(),
  listDatabaseStorage: vi.fn(),
  listSchemaInfos: vi.fn(),
  listSchemas: vi.fn(),
  toast: vi.fn(),
  editorSettings: {
    shortcuts: {},
    objectBrowserViewMode: "list" as "list" | "grid" | "compact",
    objectBrowserCompactWidth: 160,
  },
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: (...args: unknown[]) => mocks.listDatabases(...args),
  listDatabaseMetadata: (...args: unknown[]) => mocks.listDatabaseMetadata(...args),
  listDatabaseStorage: (...args: unknown[]) => mocks.listDatabaseStorage(...args),
  listSchemaInfos: (...args: unknown[]) => mocks.listSchemaInfos(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ setDefaultDatabase: vi.fn(), clearDefaultDatabase: vi.fn() }),
}));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ openObjectBrowser: vi.fn(), createTab: vi.fn() }),
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: reactive(mocks.editorSettings),
    updateEditorSettings: (patch: Partial<typeof mocks.editorSettings>) => Object.assign(mocks.editorSettings, patch),
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/components/sidebar/SidebarTreeRuntimeHost.vue", () => ({
  default: {
    setup(_props: unknown, { expose }: { expose: (value: unknown) => void }) {
      expose({ buildContextMenu: () => [] });
      return () => null;
    },
  },
}));
vi.mock("@/components/sidebar/SidebarTreeItemDialogs.vue", () => ({ default: { render: () => null } }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn() }));

import DatabaseBrowser from "@/components/objects/DatabaseBrowser.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];

async function flush(ticks = 6) {
  for (let index = 0; index < ticks; index += 1) await nextTick();
}

/** happy-dom's ResizeObserver is a no-op, so only the revalidate watch can re-measure. */
function stubRowWidth(row: HTMLElement, contentAt: () => number, clientWidth = 320) {
  Object.defineProperty(row, "clientWidth", { configurable: true, get: () => clientWidth });
  Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => Math.max(clientWidth, contentAt()) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDatabases.mockResolvedValue([{ name: "app" }]);
  mocks.listDatabaseMetadata.mockResolvedValue([]);
  mocks.listDatabaseStorage.mockResolvedValue([]);
  mocks.listSchemaInfos.mockResolvedValue([]);
  mocks.listSchemas.mockResolvedValue([]);
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
});

async function mountBrowser(connection: { value: ConnectionConfig }) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(DatabaseBrowser, { connection: connection.value }) });
  mounted.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listDatabases).toHaveBeenCalled());
  await flush();
  return host;
}

function overflowTrigger(host: HTMLElement) {
  return host.querySelector('[aria-label="toolbar.moreActions"]');
}

describe("DatabaseBrowser toolbar revalidation", () => {
  it("re-measures when the connection is renamed and the chip changes width", async () => {
    const connection = ref({ id: "mysql-a", name: "MySQL", db_type: "mysql" } as ConnectionConfig);
    const host = await mountBrowser(connection);
    const row = host.querySelector<HTMLElement>("[data-toolbar-row]")!;
    expect(row).not.toBeNull();
    // Only a long name can push the row past its width; the rename is what
    // changes the chip's extent, not the row's box. The condensed layout is
    // modelled as fitting again, like the real row.
    stubRowWidth(row, () => (host.querySelector('[aria-label="toolbar.moreActions"]') ? 300 : connection.value.name === "MySQL" ? 260 : 520));

    expect(row.textContent).toContain("MySQL");
    expect(overflowTrigger(host)).toBeNull();

    connection.value = { ...connection.value, name: "MySQL Production Cluster" };
    await flush();
    expect(host.textContent).toContain("MySQL Production Cluster");
    expect(overflowTrigger(host)).not.toBeNull();

    connection.value = { ...connection.value, name: "MySQL" };
    await flush();
    expect(row.textContent).toContain("MySQL");
    expect(overflowTrigger(host)).toBeNull();
  });
});
