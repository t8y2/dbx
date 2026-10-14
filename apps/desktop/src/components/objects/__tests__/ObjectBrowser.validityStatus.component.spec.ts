// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig, ObjectBrowserViewMode, ObjectInfo } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  getObjectSource: vi.fn(),
  ensureConnected: vi.fn(),
  viewMode: "list" as ObjectBrowserViewMode,
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  getObjectSource: (...args: unknown[]) => mocks.getObjectSource(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
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
      objectBrowserViewMode: mocks.viewMode,
      objectBrowserShowCheckbox: false,
      sidebarActivation: "double",
    },
  }),
}));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => {
      if (key === "objects.validStatus") return "VALID";
      if (key === "objects.invalidStatus") return "INVALID";
      if (key === "objects.source") return "Source";
      return key;
    },
    locale: ref("en-US"),
  }),
}));
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
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = {
  id: "validity-connection",
  name: "Dameng",
  db_type: "dameng",
  database: "DAMENG",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const mockObjects: ObjectInfo[] = [
  { name: "valid_view", object_type: "VIEW", schema: "APP", valid: true },
  { name: "invalid_view", object_type: "VIEW", schema: "APP", valid: false },
  { name: "valid_proc", object_type: "PROCEDURE", schema: "APP", valid: true },
  { name: "invalid_proc", object_type: "PROCEDURE", schema: "APP", valid: false },
  { name: "invalid_func", object_type: "FUNCTION", schema: "APP", valid: false },
  { name: "invalid_pkg", object_type: "PACKAGE", schema: "APP", valid: false },
  { name: "plain_table", object_type: "TABLE", schema: "APP", valid: null },
];

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];
const gridStyle = document.createElement("style");
gridStyle.textContent = ".object-browser-grid-wrapper { padding: 8px; }";

beforeEach(() => {
  document.head.append(gridStyle);
  vi.clearAllMocks();
  mocks.viewMode = "list";
  mocks.listSchemas.mockResolvedValue(["APP"]);
  mocks.listObjects.mockResolvedValue(mockObjects);
  mocks.getObjectSource.mockResolvedValue("CREATE OR REPLACE PROCEDURE invalid_proc AS BEGIN NULL; END;");
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
  gridStyle.remove();
});

async function mountBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup: () => () => h(ObjectBrowser, { connection, database: "DAMENG", schema: "APP", selectedObjectFilter: "all" }),
  });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector('[title="valid_view"]')).not.toBeNull());
  return host;
}

function findObjectContainer(host: HTMLElement, name: string): HTMLElement {
  const rowOrCard = host.querySelector(`[title="${name}"]`)?.closest<HTMLElement>(".cursor-default");
  expect(rowOrCard, `expected row/card for ${name}`).toBeTruthy();
  return rowOrCard!;
}

describe("ObjectBrowser validity indicators", () => {
  it("renders red invalid indicator icon and status badges for invalid views, procedures, and functions in list view", async () => {
    mocks.viewMode = "list";
    const host = await mountBrowser();

    // Invalid objects have indicator icon
    const invalidView = findObjectContainer(host, "invalid_view");
    expect(invalidView.querySelector('[data-invalid-object-indicator="true"]')).not.toBeNull();
    expect(invalidView.textContent).toContain("INVALID");

    const invalidProc = findObjectContainer(host, "invalid_proc");
    expect(invalidProc.querySelector('[data-invalid-object-indicator="true"]')).not.toBeNull();
    expect(invalidProc.textContent).toContain("INVALID");

    const invalidFunc = findObjectContainer(host, "invalid_func");
    expect(invalidFunc.querySelector('[data-invalid-object-indicator="true"]')).not.toBeNull();
    expect(invalidFunc.textContent).toContain("INVALID");

    const invalidPkg = findObjectContainer(host, "invalid_pkg");
    expect(invalidPkg.querySelector('[data-invalid-object-indicator="true"]')).not.toBeNull();
    expect(invalidPkg.textContent).toContain("INVALID");

    // Valid objects do not have indicator icon, but have VALID badge
    const validView = findObjectContainer(host, "valid_view");
    expect(validView.querySelector('[data-invalid-object-indicator="true"]')).toBeNull();
    expect(validView.textContent).toContain("VALID");

    const validProc = findObjectContainer(host, "valid_proc");
    expect(validProc.querySelector('[data-invalid-object-indicator="true"]')).toBeNull();
    expect(validProc.textContent).toContain("VALID");

    // Null validity object has neither
    const plainTable = findObjectContainer(host, "plain_table");
    expect(plainTable.querySelector('[data-invalid-object-indicator="true"]')).toBeNull();
    expect(plainTable.textContent).not.toContain("INVALID");
    expect(plainTable.textContent).not.toContain("VALID");
  });

  it("renders red invalid indicator icon and status badges in grid view", async () => {
    mocks.viewMode = "grid";
    const host = await mountBrowser();

    const invalidView = findObjectContainer(host, "invalid_view");
    expect(invalidView.querySelector('[data-invalid-object-indicator="true"]')).not.toBeNull();
    expect(invalidView.textContent).toContain("INVALID");

    const invalidProc = findObjectContainer(host, "invalid_proc");
    expect(invalidProc.querySelector('[data-invalid-object-indicator="true"]')).not.toBeNull();
    expect(invalidProc.textContent).toContain("INVALID");

    const validProc = findObjectContainer(host, "valid_proc");
    expect(validProc.querySelector('[data-invalid-object-indicator="true"]')).toBeNull();
    expect(validProc.textContent).toContain("VALID");

    const plainTable = findObjectContainer(host, "plain_table");
    expect(plainTable.querySelector('[data-invalid-object-indicator="true"]')).toBeNull();
    expect(plainTable.textContent).not.toContain("INVALID");
    expect(plainTable.textContent).not.toContain("VALID");
  });

  it("shows invalid status badge in side panel header when an invalid routine is selected", async () => {
    mocks.viewMode = "list";
    const host = await mountBrowser();

    const invalidProc = findObjectContainer(host, "invalid_proc");
    invalidProc.click();
    await nextTick();

    await vi.waitFor(() => {
      const header = host.querySelector(".border-b.bg-muted\\/20");
      expect(header).not.toBeNull();
      expect(header?.textContent).toContain("INVALID");
    });
  });
});
