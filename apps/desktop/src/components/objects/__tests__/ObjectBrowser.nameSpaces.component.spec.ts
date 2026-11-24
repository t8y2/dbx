// @vitest-environment happy-dom
//
// Review follow-up (#14905): ` orders` and `orders` are two different MySQL
// tables, but both rows rendered the same trimmed text, so the target could only
// be told apart after opening the context menu. The name column now draws a
// marker for the spaces the identifier actually carries.

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  listObjectStatistics: vi.fn(),
  mongoListCollections: vi.fn(),
  ensureConnected: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: (...args: unknown[]) => mocks.listObjectStatistics(...args),
  mongoListCollections: (...args: unknown[]) => mocks.mongoListCollections(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => connection,
    ensureConnected: mocks.ensureConnected,
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
// Labels resolve to their keys so assertions stay locale-independent.
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
  id: "mysql-cmgt",
  name: "MySQL",
  db_type: "mysql",
  database: "cmgt",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSchemas.mockResolvedValue([]);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listObjectStatistics.mockResolvedValue([]);
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser(objects: Array<{ name: string; object_type: string }>) {
  mocks.listObjects.mockResolvedValue(objects);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "cmgt" }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalled());
  return host;
}

describe("object browser name column and space-padded identifiers", () => {
  it("marks the row whose identifier keeps a leading space", async () => {
    const host = await mountBrowser([
      { name: " orders", object_type: "TABLE" },
      { name: "orders", object_type: "TABLE" },
    ]);

    const markers = host.querySelectorAll("[data-object-name-leading-space]");
    expect(markers).toHaveLength(1);
    expect(host.querySelectorAll("[data-object-name-trailing-space]")).toHaveLength(0);

    // Both rows still read "orders"; the marker is what separates them, and the
    // padded row keeps its exact identifier on hover.
    expect(host.textContent?.split("orders").length).toBe(3);
    const paddedCell = markers[0].parentElement;
    expect(paddedCell?.getAttribute("title")).toBe("` orders`");
  });

  it("marks a trailing space instead of a leading one", async () => {
    const host = await mountBrowser([{ name: "orders ", object_type: "TABLE" }]);

    expect(host.querySelectorAll("[data-object-name-leading-space]")).toHaveLength(0);
    expect(host.querySelectorAll("[data-object-name-trailing-space]")).toHaveLength(1);
    expect(host.querySelector("[data-object-name-trailing-space]")?.parentElement?.getAttribute("title")).toBe("`orders `");
  });

  it("draws no marker when no identifier carries surrounding spaces", async () => {
    const host = await mountBrowser([
      { name: "orders", object_type: "TABLE" },
      { name: "customers", object_type: "TABLE" },
    ]);

    expect(host.querySelector("[data-object-name-leading-space]")).toBeNull();
    expect(host.querySelector("[data-object-name-trailing-space]")).toBeNull();
  });
});
