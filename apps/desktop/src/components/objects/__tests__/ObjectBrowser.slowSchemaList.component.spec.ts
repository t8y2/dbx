// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";

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
    ensureConnected: mocks.ensureConnected,
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
  id: "dameng-slow-schemas",
  name: "Dameng",
  db_type: "dameng",
  database: "TEST",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listObjects.mockResolvedValue([{ name: "TEST2026", object_type: "TABLE" }]);
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

async function mountBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "TEST", schema: "TEST" }) });
  mountedApps.push({ app, host });
  app.mount(host);
  return host;
}

describe("ObjectBrowser with a slow schema list", () => {
  it("loads the object list without waiting for listSchemas (#8665)", async () => {
    // listSchemas 一直不返回，模拟达梦扫描庞大 SYS.SYSOBJECTS 的场景。
    mocks.listSchemas.mockReturnValue(new Promise<string[]>(() => {}));

    const host = await mountBrowser();

    await vi.waitFor(() => expect(host.textContent).toContain("TEST2026"));
    expect(mocks.listObjects).toHaveBeenCalledWith("dameng-slow-schemas", "TEST", "TEST", undefined, undefined, undefined, undefined, undefined);
    expect(mocks.listSchemas).toHaveBeenCalledWith("dameng-slow-schemas", "TEST");
    expect(host.textContent).not.toContain("objects.empty");
  });

  it("still applies the schema list once a slow listSchemas resolves", async () => {
    let resolveSchemas: (names: string[]) => void = () => undefined;
    mocks.listSchemas.mockReturnValue(new Promise<string[]>((resolve) => (resolveSchemas = resolve)));

    const host = await mountBrowser();
    await vi.waitFor(() => expect(host.textContent).toContain("TEST2026"));

    resolveSchemas(["TEST", "OTHER"]);
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(1));
  });
});
