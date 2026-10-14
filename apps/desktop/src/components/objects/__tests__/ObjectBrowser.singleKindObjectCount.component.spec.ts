// @vitest-environment happy-dom
//
// t8y2/dbx#11624: a scope holding a single object kind (the common MySQL "tables only"
// database) used to render no object count at all, because the per-kind strip is dropped
// whenever "全部 N" and "<kind> N" would repeat the same number. These specs pin the
// replacement: that one kind's count stays visible, stays read-only, and still follows the
// search query. The condensed-toolbar variant (tier >= 2, count moves into the overflow
// menu) is not covered here: the harness stubs ToolbarOverflowMenu out and happy-dom cannot
// drive the measured condensation.

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
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

// A MongoDB scope lists collections only, so the single-kind path is the normal one there.
const mongoConnection = {
  id: "mongo-cmgt",
  name: "MongoDB",
  db_type: "mongodb",
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

async function mountMongoBrowser(collections: Array<{ name: string; kind?: string }>) {
  mocks.mongoListCollections.mockResolvedValue(collections);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection: mongoConnection, database: "cmgt" }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.mongoListCollections).toHaveBeenCalled());
  return host;
}

function countLabel(host: HTMLElement): Element | null {
  return host.querySelector("[data-object-filter-count]");
}

async function typeSearch(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>("[data-object-search-input]");
  expect(input).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event("input"));
  await nextTick();
  await nextTick();
}

describe("object browser count for a single-kind scope (#11624)", () => {
  it("shows the only kind's count instead of dropping the strip entirely", async () => {
    const host = await mountBrowser([
      { name: "orders", object_type: "TABLE" },
      { name: "customers", object_type: "TABLE" },
    ]);

    const label = countLabel(host);
    expect(label?.textContent?.trim()).toBe("objects.tables 2");
    // No redundant "全部 2 / 表 2" strip…
    expect(host.querySelector("[data-object-filter-chips]")).toBeNull();
    // …and the statistic is a value, not a filter control: with a single kind there would be
    // no 全部 chip left to reset a selection made here.
    expect(label?.tagName).toBe("SPAN");
    expect(label?.closest("button")).toBeNull();
  });

  it("keeps the count in step with the search query", async () => {
    const host = await mountBrowser([
      { name: "orders", object_type: "TABLE" },
      { name: "customers", object_type: "TABLE" },
    ]);
    expect(countLabel(host)?.textContent?.trim()).toBe("objects.tables 2");

    await typeSearch(host, "order");

    expect(countLabel(host)?.textContent?.trim()).toBe("objects.tables 1");
  });

  it("leaves a multi-kind scope on the clickable strip", async () => {
    const host = await mountBrowser([
      { name: "orders", object_type: "TABLE" },
      { name: "audit_log", object_type: "TRIGGER" },
    ]);

    const chips = host.querySelector("[data-object-filter-chips]");
    expect(chips).not.toBeNull();
    expect([...chips!.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["objects.all 2", "objects.tables 1", "tree.triggers 1"]);
    expect(countLabel(host)).toBeNull();
  });

  it("shows nothing for an empty scope", async () => {
    const host = await mountBrowser([]);

    expect(countLabel(host)).toBeNull();
    expect(host.querySelector("[data-object-filter-chips]")).toBeNull();
  });

  it("labels a single-kind MongoDB scope with its collection count", async () => {
    const host = await mountMongoBrowser([
      { name: "events", kind: "collection" },
      { name: "sessions", kind: "collection" },
    ]);

    // Collections-only is the normal MongoDB shape, and its wording differs from tables.
    expect(countLabel(host)?.textContent?.trim()).toBe("objects.collections 2");
    expect(host.querySelector("[data-object-filter-chips]")).toBeNull();
  });
});
