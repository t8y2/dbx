// @vitest-environment happy-dom
//
// Review follow-ups for the sidebar "double-click a group row" entry point:
// 1. a first-time open must select the same category a reused tab selects, so a
//    double-clicked group never lands somewhere else just because the tab is new;
// 2. a group that opens empty (no triggers, no views) must still leave a control
//    that goes back to 全部 — the category strip used to be hidden in that case.

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig, ObjectFilter } from "@/types/database";

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

async function mountBrowser(objects: Array<{ name: string; object_type: string }>, initialObjectFilter?: ObjectFilter) {
  mocks.listObjects.mockResolvedValue(objects);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "cmgt", initialObjectFilter }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalled());
  return host;
}

function chips(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("[data-object-filter-chips] button")];
}

function activeChipLabel(host: HTMLElement): string | undefined {
  return chips(host)
    .find((button) => button.className.includes("bg-background"))
    ?.textContent?.trim();
}

async function openWithFilterSwitch(objects: Array<{ name: string; object_type: string }>, first: ObjectFilter, next: ObjectFilter) {
  mocks.listObjects.mockResolvedValue(objects);
  const initialFilter = ref<ObjectFilter | undefined>(first);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "cmgt", initialObjectFilter: initialFilter.value }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalled());

  // Reusing the tab only changes the incoming prop.
  initialFilter.value = next;
  await nextTick();
  await nextTick();
  return host;
}

describe("object browser category selection from a sidebar group", () => {
  it("selects the triggers category on the first open of a MySQL database", async () => {
    const host = await mountBrowser(
      [
        { name: "orders", object_type: "TABLE" },
        { name: "audit_log", object_type: "TRIGGER" },
      ],
      "triggers",
    );

    expect(activeChipLabel(host)).toBe("tree.triggers 1");
    expect(host.textContent).toContain("audit_log");
    expect(host.textContent).not.toContain("orders");
  });

  it("selects the same triggers category when the tab is reused", async () => {
    const host = await openWithFilterSwitch(
      [
        { name: "orders", object_type: "TABLE" },
        { name: "audit_log", object_type: "TRIGGER" },
      ],
      "tables",
      "triggers",
    );

    // First open and reuse must agree; the assertion is the same one used above.
    expect(activeChipLabel(host)).toBe("tree.triggers 1");
    expect(host.textContent).toContain("audit_log");
  });

  it("keeps a control back to 全部 when a group opens empty", async () => {
    const host = await mountBrowser([{ name: "orders", object_type: "TABLE" }], "views");

    const labels = chips(host).map((button) => button.textContent?.trim());
    // The empty category is kept, with its real count, right after 全部.
    expect(labels).toEqual(["objects.all 1", "objects.views 0", "objects.tables 1"]);
    expect(activeChipLabel(host)).toBe("objects.views 0");
    // The empty category really is empty…
    expect(host.textContent).not.toContain("orders");

    // …and 全部 is the way out instead of a hidden strip. With a single kind
    // left in scope the strip collapses back to the read-only count.
    chips(host)[0].click();
    await nextTick();
    expect(activeChipLabel(host)).toBeUndefined();
    expect(host.querySelector("[data-object-filter-count]")?.textContent?.trim()).toBe("objects.tables 1");
    expect(host.textContent).toContain("orders");
  });
});
