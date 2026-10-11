// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { invalidateMetadataRuntimeCachePrefix } from "@/lib/metadata/metadataRuntimeCache";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({ listConstraints: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  listObjects: vi.fn().mockResolvedValue([{ name: "O01_CONSTRAINTS", object_type: "TABLE", schema: "TESTER" }]),
  listSchemas: vi.fn().mockResolvedValue(["TESTER"]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getTableDisplayDdl: vi.fn().mockResolvedValue("CREATE TABLE O01_CONSTRAINTS (A NUMBER, B NUMBER)"),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  listConstraints: (...args: unknown[]) => mocks.listConstraints(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => connection,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
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
      sidebarActivation: "double",
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
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = { id: "ob-o01-constraints", name: "OceanBase Oracle", db_type: "oceanbase-oracle", database: "TESTER", driver_profile: null, url_params: null, transport_layers: [] } as unknown as ConnectionConfig;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConstraints.mockResolvedValue([
    {
      name: "O01_UK",
      constraint_type: "UNIQUE",
      definition: 'UNIQUE ("B", "A")',
      columns: ["B", "A"],
      ref_columns: [],
      enabled: true,
      valid: true,
    },
  ]);
  invalidateObjectBrowserRowsCache({});
  invalidateMetadataRuntimeCachePrefix("");
});
afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
  invalidateMetadataRuntimeCachePrefix("");
});

async function openConstraints() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(ObjectBrowser, { connection, database: "TESTER", schema: "TESTER" });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector('[title="O01_CONSTRAINTS"]')).not.toBeNull());
  host.querySelector<HTMLElement>('[title="O01_CONSTRAINTS"]')!.closest<HTMLElement>(".cursor-default")!.click();
  await vi.waitFor(() => expect(host.querySelector('button[title="grid.tableInfoConstraints"]')).not.toBeNull());
  host.querySelector<HTMLButtonElement>('button[title="grid.tableInfoConstraints"]')!.click();
  return host;
}

describe("OceanBase Oracle constraint information", () => {
  it("opens its read-only Constraints tab and displays ordered metadata from the agent", async () => {
    const host = await openConstraints();
    await vi.waitFor(() => expect(host.textContent).toContain('UNIQUE ("B", "A")'));
    expect(host.textContent).toContain("B, A");
    expect(host.textContent).toContain("grid.tableInfoConstraintEnabled");
    expect(host.textContent).toContain("grid.tableInfoConstraintValidated");
    expect(mocks.listConstraints).toHaveBeenCalledWith(connection.id, "TESTER", "TESTER", "O01_CONSTRAINTS", undefined);
  });

  it("keeps permission errors visible instead of an empty list and can retry", async () => {
    mocks.listConstraints.mockRejectedValueOnce(new Error("ORA-01031: insufficient privileges"));
    const host = await openConstraints();
    await vi.waitFor(() => expect(host.textContent).toContain("ORA-01031: insufficient privileges"));
    expect(host.textContent).not.toContain("grid.tableInfoEmpty");

    host.querySelector<HTMLButtonElement>('button[aria-label="structureEditor.refresh"]')!.click();
    await vi.waitFor(() => expect(host.textContent).toContain('UNIQUE ("B", "A")'));
    expect(host.textContent).not.toContain("ORA-01031");
  });

  it("shows an empty result only after a successful empty catalog read", async () => {
    mocks.listConstraints.mockResolvedValue([]);
    const host = await openConstraints();
    await vi.waitFor(() => expect(host.textContent).toContain("grid.tableInfoEmpty"));
    expect(host.textContent).not.toContain("ORA-01031");
  });
});
