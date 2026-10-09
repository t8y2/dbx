// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(),
  buildExecutableObjectSourceStatements: vi.fn(),
  executeQuery: vi.fn(),
  ensureConnected: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getObjectSource: (...args: unknown[]) => mocks.getObjectSource(...args),
  buildEditableObjectSource: (...args: unknown[]) => mocks.buildEditableObjectSource(...args),
  buildExecutableObjectSourceStatements: (...args: unknown[]) => mocks.buildExecutableObjectSourceStatements(...args),
  executeQuery: (...args: unknown[]) => mocks.executeQuery(...args),
}));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionSqlGuard: async ({ execute }: { execute: () => Promise<unknown> }) => execute(),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    treeClipboard: null,
    ensureConnected: mocks.ensureConnected,
    getConfig: () => connection,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  }),
}));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ openObjectSourceTabPending: vi.fn() }),
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: "list",
      objectBrowserShowCheckbox: false,
      sidebarActivation: "single",
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
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
  id: "mysql-views",
  name: "MySQL",
  db_type: "mysql",
  database: "app",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const VIEW_NAME = "v_demo";
const VIEW_SQL = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_demo` AS select 1 AS `id`";
const ALTER_SQL = "ALTER ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_demo` AS select 1 AS `id`";

const SINGLE_CLICK_DELAY = 250;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listObjects.mockResolvedValue([{ name: VIEW_NAME, schema: "app", object_type: "VIEW" }]);
  mocks.listSchemas.mockResolvedValue([]);
  mocks.getObjectSource.mockResolvedValue({ source: VIEW_SQL, editable: true });
  mocks.buildEditableObjectSource.mockImplementation(async (options: { source: string }) => options.source);
  mocks.buildExecutableObjectSourceStatements.mockResolvedValue([ALTER_SQL]);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.ensureConnected.mockResolvedValue(undefined);
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  vi.useRealTimers();
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "app" }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.textContent).toContain(VIEW_NAME));
  return host;
}

function rowFor(host: HTMLElement, name: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>(".grid.h-\\[34px\\]")].find((element) => element.textContent?.includes(name));
  expect(row, name).toBeDefined();
  return row!;
}

function saveButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "objects.saveSource");
}

function click(element: HTMLElement, detail = 1) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
}

async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await nextTick();
  }
}

/** A VIEW row's single click is deferred by SINGLE_CLICK_DELAY before it opens the panel. */
async function clickRow(host: HTMLElement, name: string) {
  click(rowFor(host, name));
  await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);
  await settle();
}

describe("ObjectBrowser view source save", () => {
  it("keeps the Save button idle and usable after a successful view-source save", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();

    // Single click on a VIEW row opens the source side panel in edit mode.
    await clickRow(host, VIEW_NAME);

    const save = saveButton(host);
    expect(save, "save button").toBeDefined();
    expect(save!.disabled).toBe(false);
    expect(save!.querySelector(".animate-spin")).toBeNull();

    click(save!);
    await settle();
    expect(mocks.executeQuery).toHaveBeenCalledWith("mysql-views", "app", ALTER_SQL, "app");
    expect(mocks.toast).toHaveBeenCalledWith("objects.sourceSaved");
    // The success path closes the panel (same row + source mode).
    expect(saveButton(host)).toBeUndefined();

    // Re-opening the same view must not inherit the previous save's spinner:
    // the save's finally() cannot clear it once the panel closed and bumped the
    // request-guard epoch, so the new panel load owns that state.
    await clickRow(host, VIEW_NAME);

    const reopened = saveButton(host);
    expect(reopened, "reopened save button").toBeDefined();
    expect(reopened!.querySelector(".animate-spin")).toBeNull();
    expect(reopened!.disabled).toBe(false);
  });
});
