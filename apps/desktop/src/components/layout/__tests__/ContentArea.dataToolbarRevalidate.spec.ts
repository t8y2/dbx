// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const mocks = vi.hoisted(() => ({
  openTableStructureEditor: vi.fn(() => true),
  loadOpenTabsState: vi.fn(async () => null),
  saveOpenTabsState: vi.fn(async () => undefined),
  listPlugins: vi.fn(async () => []),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  loadOpenTabsState: mocks.loadOpenTabsState,
  saveOpenTabsState: mocks.saveOpenTabsState,
  listPlugins: mocks.listPlugins,
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: {
    setup(_props: unknown, { expose }: { expose: (value: unknown) => void }) {
      expose({ canOpenTableStructureEditor: true, openTableStructureEditor: mocks.openTableStructureEditor });
      return () => null;
    },
  },
}));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const connection: ConnectionConfig = {
  id: "mysql-a",
  name: "MySQL",
  db_type: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "",
};

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  localStorage.clear();
});

async function flush(ticks = 6) {
  for (let index = 0; index < ticks; index += 1) await nextTick();
}

async function mountDataTab() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useConnectionStore().connections = [connection];
  const store = useQueryStore();
  const tab = reactive<QueryTab>({
    id: "orders",
    title: "orders",
    connectionId: connection.id,
    database: "app",
    mode: "data",
    sql: "SELECT * FROM orders",
    isExecuting: false,
    tableMeta: { tableName: "orders", columns: [], primaryKeys: [] },
    result: { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 },
  });
  store.tabs = [tab];
  store.groups = [{ id: "main", tabIds: [tab.id], activeTabId: tab.id }];
  store.switchTab(tab.id);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    setup: () => () =>
      h(ContentArea, {
        activeTab: tab,
        activeConnection: connection,
        activeOutputView: "result",
        executableSql: "",
        formatSqlRequest: null,
        compressSqlRequest: null,
        selectedSql: "",
        cursorPos: 0,
        blockDangerousRedisCommands: false,
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mounted.push({ app, host });
  // Let the lazily imported grid mount so its capability revalidate fires
  // before the widths are stubbed.
  await vi.waitFor(() => expect(host.querySelector("[data-edit-table-structure]")).not.toBeNull());
  await flush();
  return { host, settings: useSettingsStore() };
}

/** The row reports tier >= 1 by collapsing the breadcrumb to icon-only. */
function rowIsCompact(host: HTMLElement) {
  return !host.querySelector("[data-data-header-connection]")?.textContent?.trim();
}

/** happy-dom's ResizeObserver is a no-op, so only the revalidate watch can re-measure. */
function stubRowWidth(row: HTMLElement, contentAt: () => number, clientWidth = 420) {
  Object.defineProperty(row, "clientWidth", { configurable: true, get: () => clientWidth });
  Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => Math.max(clientWidth, contentAt()) });
}

describe("ContentArea data toolbar revalidation", () => {
  it("shows and hides the toolbar labels with the hide-toolbar-labels setting", async () => {
    const { host, settings } = await mountDataTab();
    const label = () => host.querySelector("[data-toolbar-row]")?.textContent?.includes("grid.tableInfo") ?? false;

    expect(label()).toBe(true);
    settings.updateEditorSettings({ dataGridHideToolbarLabels: true });
    await flush();
    expect(label()).toBe(false);
    settings.updateEditorSettings({ dataGridHideToolbarLabels: false });
    await flush();
    expect(label()).toBe(true);
  });

  it("re-measures the row when the hide-toolbar-labels setting changes", async () => {
    const { host, settings } = await mountDataTab();
    settings.updateEditorSettings({ dataGridHideToolbarLabels: true });
    await flush();

    const row = host.querySelector<HTMLElement>("[data-toolbar-row]")!;
    expect(row).not.toBeNull();
    // Labels are what push the row past its width; hiding them makes it fit
    // again. The row's box never changes, so only the setting change can
    // re-measure it.
    stubRowWidth(row, () => (settings.editorSettings.dataGridHideToolbarLabels ? 300 : rowIsCompact(host) ? 250 : 520));

    expect(rowIsCompact(host)).toBe(false);

    settings.updateEditorSettings({ dataGridHideToolbarLabels: false });
    await flush();
    expect(rowIsCompact(host)).toBe(true);

    settings.updateEditorSettings({ dataGridHideToolbarLabels: true });
    await flush();
    expect(rowIsCompact(host)).toBe(false);
  });
});
