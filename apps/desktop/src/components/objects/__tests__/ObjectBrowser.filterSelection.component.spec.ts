// @vitest-environment happy-dom
//
// t8y2/dbx#13940: switching the object-type filter used to leave selectedTableIds
// sticky across kinds. Export then pulled names from the full-type selectableRows
// set, so a sequences → views switch still exported sequence names. These specs
// pin the intended behavior: filter change clears selection, and after
// switch + select-all, batch export tableNames are only the current kind.

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  listObjectStatistics: vi.fn(),
  ensureConnected: vi.fn(),
  store: {
    databaseExportSource: null as null | {
      connectionId: string;
      database: string;
      schema?: string;
      tableNames: string[];
    },
  },
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
    tableNameFilterForScope: () => undefined,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
    get databaseExportSource() {
      return mocks.store.databaseExportSource;
    },
    set databaseExportSource(value: typeof mocks.store.databaseExportSource) {
      mocks.store.databaseExportSource = value;
    },
  }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: "list",
      objectBrowserShowCheckbox: true,
      sidebarCopyTableNameSeparator: "newline",
      sidebarCopyTableNameIncludeSchema: false,
    },
    updateEditorSettings: vi.fn(),
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
  id: "pg-filter-selection",
  name: "Postgres",
  db_type: "postgresql",
  database: "app",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.databaseExportSource = null;
  mocks.listSchemas.mockResolvedValue(["public"]);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listObjectStatistics.mockResolvedValue([]);
  mocks.listObjects.mockResolvedValue([
    { name: "orders", object_type: "TABLE", schema: "public" },
    { name: "users", object_type: "TABLE", schema: "public" },
    { name: "orders_v", object_type: "VIEW", schema: "public" },
    { name: "users_v", object_type: "VIEW", schema: "public" },
    { name: "seq_orders", object_type: "SEQUENCE", schema: "public" },
    { name: "seq_users", object_type: "SEQUENCE", schema: "public" },
  ]);
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
  const app = createApp({
    setup: () => () => h(ObjectBrowser, { connection, database: "app", schema: "public" }),
  });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector("[data-object-filter-chips]")).not.toBeNull());
  await vi.waitFor(() => expect(host.textContent).toContain("orders"));
  return host;
}

function filterChip(host: HTMLElement, labelKey: string): HTMLButtonElement {
  const chips = host.querySelector("[data-object-filter-chips]");
  expect(chips).not.toBeNull();
  const button = [...chips!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(labelKey));
  expect(button, labelKey).toBeDefined();
  return button!;
}

async function selectObjectFilterChip(host: HTMLElement, labelKey: string) {
  filterChip(host, labelKey).click();
  await nextTick();
  await nextTick();
}

function selectAllVisibleButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(".object-browser-table button");
  expect(button).not.toBeNull();
  return button!;
}

async function selectAllVisible(host: HTMLElement) {
  selectAllVisibleButton(host).click();
  await nextTick();
}

function selectionBar(host: HTMLElement): HTMLElement | null {
  const exportButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("objects.exportSelected"));
  return exportButton?.closest("div.flex.h-9") ?? null;
}

async function exportSelected(host: HTMLElement) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("objects.exportSelected"));
  expect(button).toBeDefined();
  button!.click();
  await nextTick();
}

describe("object browser filter selection (#13940)", () => {
  it("clears the sticky selection when switching objectFilter", async () => {
    const host = await mountBrowser();

    await selectObjectFilterChip(host, "objects.sequences");
    await vi.waitFor(() => expect(host.textContent).toContain("seq_orders"));
    await selectAllVisible(host);
    expect(selectionBar(host)).not.toBeNull();

    await selectObjectFilterChip(host, "objects.views");
    await vi.waitFor(() => expect(host.textContent).toContain("orders_v"));
    expect(selectionBar(host)).toBeNull();
    expect(mocks.store.databaseExportSource).toBeNull();
  });

  it("exports only the current filter's names after switch + select-all", async () => {
    const host = await mountBrowser();

    await selectObjectFilterChip(host, "objects.sequences");
    await vi.waitFor(() => expect(host.textContent).toContain("seq_users"));
    await selectAllVisible(host);
    expect(selectionBar(host)).not.toBeNull();

    await selectObjectFilterChip(host, "objects.views");
    await vi.waitFor(() => expect(host.textContent).toContain("users_v"));
    expect(selectionBar(host)).toBeNull();

    await selectAllVisible(host);
    expect(selectionBar(host)).not.toBeNull();
    await exportSelected(host);

    expect(mocks.store.databaseExportSource).toEqual({
      connectionId: connection.id,
      database: "app",
      schema: "public",
      tableNames: ["orders_v", "users_v"],
    });
    expect(mocks.store.databaseExportSource?.tableNames).not.toEqual(expect.arrayContaining(["seq_orders", "seq_users"]));
  });
});
