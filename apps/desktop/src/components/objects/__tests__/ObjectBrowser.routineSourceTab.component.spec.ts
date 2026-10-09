// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(),
  ensureConnected: vi.fn(),
  openObjectSourceTabPending: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getObjectSource: (...args: unknown[]) => mocks.getObjectSource(...args),
  buildEditableObjectSource: (...args: unknown[]) => mocks.buildEditableObjectSource(...args),
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
  useQueryStore: () => ({ openObjectSourceTabPending: mocks.openObjectSourceTabPending }),
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
  id: "mysql-routines",
  name: "MySQL",
  db_type: "mysql",
  database: "app",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

// ObjectBrowser.vue's SINGLE_CLICK_DELAY; the deferral is what lets a second
// click cancel the side panel before it loads.
const SINGLE_CLICK_DELAY = 250;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listObjects.mockResolvedValue([
    { name: "sp_daily_report", schema: "app", object_type: "PROCEDURE", signature: "IN day DATE" },
    { name: "fn_total", schema: "app", object_type: "FUNCTION", signature: "" },
    { name: "seq_invoice", schema: "app", object_type: "SEQUENCE" },
  ]);
  mocks.listSchemas.mockResolvedValue([]);
  mocks.getObjectSource.mockResolvedValue({ source: "CREATE PROCEDURE sp_daily_report() BEGIN END", editable: true });
  mocks.buildEditableObjectSource.mockImplementation(async (options: { source: string }) => options.source);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.openObjectSourceTabPending.mockReturnValue("tab-1");
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
  await vi.waitFor(() => expect(host.textContent).toContain("sp_daily_report"));
  return host;
}

function rowFor(host: HTMLElement, name: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>(".grid.h-\\[34px\\]")].find((element) => element.textContent?.includes(name));
  expect(row, name).toBeDefined();
  return row!;
}

function click(row: HTMLElement, detail: number) {
  row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
}

describe("ObjectBrowser routine double click", () => {
  it("opens an editable source tab for a double-clicked PROCEDURE", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    const row = rowFor(host, "sp_daily_report");

    click(row, 1);
    click(row, 2);

    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledTimes(1);
    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledWith({
      connectionId: "mysql-routines",
      database: "app",
      title: "Source - sp_daily_report(IN day DATE)",
      schema: "app",
      catalog: undefined,
      initialEditing: true,
      request: { name: "sp_daily_report", objectType: "PROCEDURE", signature: "IN day DATE" },
    });
    // The second click cancelled the pending single click, so the side panel
    // never fetched the source.
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);
    expect(mocks.getObjectSource).not.toHaveBeenCalled();
  });

  it("opens an editable source tab for a double-clicked FUNCTION", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    const row = rowFor(host, "fn_total");

    click(row, 1);
    click(row, 2);

    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledWith(expect.objectContaining({ initialEditing: true, request: { name: "fn_total", objectType: "FUNCTION", signature: "" } }));
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);
    expect(mocks.getObjectSource).not.toHaveBeenCalled();
  });

  it("keeps a single click on the source side panel", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();

    click(rowFor(host, "sp_daily_report"), 1);

    // Deferred: nothing happens until the double-click window closes.
    expect(mocks.getObjectSource).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY);
    expect(mocks.getObjectSource).toHaveBeenCalledWith("mysql-routines", "app", "app", "sp_daily_report", "PROCEDURE", "IN day DATE");
    expect(mocks.openObjectSourceTabPending).not.toHaveBeenCalled();
  });

  it("leaves non-routine source rows on the side panel when double clicked", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    const row = rowFor(host, "seq_invoice");

    click(row, 1);
    click(row, 2);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);

    expect(mocks.openObjectSourceTabPending).not.toHaveBeenCalled();
    expect(mocks.getObjectSource).toHaveBeenCalledWith("mysql-routines", "app", "app", "seq_invoice", "SEQUENCE", undefined);
  });
});
