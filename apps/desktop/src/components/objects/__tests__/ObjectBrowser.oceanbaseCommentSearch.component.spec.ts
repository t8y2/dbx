// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig, ObjectBrowserViewMode, ObjectInfo } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  viewMode: "list" as ObjectBrowserViewMode,
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: vi.fn().mockResolvedValue(["APP"]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
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
      objectBrowserViewMode: mocks.viewMode,
      objectBrowserShowCheckbox: false,
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

const connection = {
  id: "ob-11417-comments",
  name: "OceanBase Oracle",
  db_type: "oceanbase-oracle",
  database: "APP",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const objects: ObjectInfo[] = [
  { name: "O11417_TABLE", object_type: "TABLE", schema: "APP", comment: "业务 Needle 100%_" },
  { name: "O11417_VIEW", object_type: "VIEW", schema: "APP", comment: "视图 NEEDLE 100XX" },
  { name: "O11417_NEEDLE", object_type: "TABLE", schema: "APP", comment: null },
  { name: "O11417_PROCEDURE", object_type: "PROCEDURE", schema: "APP", comment: null },
];
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];
const gridStyle = document.createElement("style");
gridStyle.textContent = ".object-browser-grid-wrapper { padding: 8px; }";

beforeEach(() => {
  vi.clearAllMocks();
  invalidateObjectBrowserRowsCache({});
  mocks.listObjects.mockResolvedValue(objects);
  document.head.append(gridStyle);
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
  gridStyle.remove();
});

async function searchObjects(host: HTMLElement, query: string) {
  const input = host.querySelector<HTMLInputElement>("[data-object-search-input]");
  expect(input).not.toBeNull();
  input!.value = query;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

describe("OceanBase Oracle object comments (#11417)", () => {
  it.each(["list", "grid"] as const)("displays and searches table/view comments in %s view", async (viewMode) => {
    mocks.viewMode = viewMode;
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "APP", schema: "APP", selectedObjectFilter: "all" }) });
    mountedApps.push({ app, host });
    app.mount(host);

    await vi.waitFor(() => expect(host.querySelector('[title="O11417_TABLE"]')).not.toBeNull());
    expect(host.querySelector('[title="业务 Needle 100%_"]')).not.toBeNull();
    expect(host.querySelector('[title="视图 NEEDLE 100XX"]')).not.toBeNull();

    await searchObjects(host, "nEeDlE");
    for (const name of ["O11417_TABLE", "O11417_VIEW", "O11417_NEEDLE"]) {
      expect(host.querySelector(`[title="${name}"]`)).not.toBeNull();
    }
    expect(host.querySelector('[title="O11417_PROCEDURE"]')).toBeNull();

    await searchObjects(host, "100%_");
    expect(host.querySelector('[title="O11417_TABLE"]')).not.toBeNull();
    expect(host.querySelector('[title="O11417_VIEW"]')).toBeNull();
    expect(host.querySelector('[title="O11417_NEEDLE"]')).toBeNull();

    await searchObjects(host, "");
    expect(host.querySelector('[title="O11417_PROCEDURE"]')).not.toBeNull();
  });
});
