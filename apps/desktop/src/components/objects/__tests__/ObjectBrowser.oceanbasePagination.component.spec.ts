// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig, ObjectBrowserFilter, ObjectInfo } from "@/types/database";

const mocks = vi.hoisted(() => ({ listObjects: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: vi.fn().mockResolvedValue(["APP", "OTHER"]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: () => connection, ensureConnected: vi.fn().mockResolvedValue(undefined), orderByPinnedTreeNodes: (rows: unknown[]) => rows }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    desktopSettings: { sidebar_table_page_size: 2 },
    editorSettings: { shortcuts: { refreshData: "F5" }, objectBrowserViewMode: "list", objectBrowserShowCheckbox: false },
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

const connection = { id: "ob-11418-pages", name: "OceanBase Oracle", db_type: "oceanbase-oracle", database: "APP", driver_profile: null, url_params: null, transport_layers: [] } as unknown as ConnectionConfig;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];
const object = (name: string, schema = "APP"): ObjectInfo => ({ name, schema, object_type: "TABLE", comment: "业务 Needle 100%_" });

beforeEach(() => {
  vi.clearAllMocks();
  invalidateObjectBrowserRowsCache({});
});
afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser(selectedObjectFilter: ObjectBrowserFilter | null = "all") {
  const schema = ref("APP");
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "APP", schema: schema.value, selectedObjectFilter: selectedObjectFilter ?? undefined }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalled());
  return { host, schema };
}

async function searchObjects(host: HTMLElement, query: string) {
  const input = host.querySelector<HTMLInputElement>("[data-object-search-input]")!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

describe("OceanBase Oracle object pagination (#11418)", () => {
  it("starts the default table tab with a typed request", async () => {
    mocks.listObjects.mockResolvedValue([object("O11418_1")]);
    await mountBrowser(null);
    expect(mocks.listObjects).toHaveBeenCalledWith(connection.id, "APP", "APP", ["TABLE"], undefined, 3, 0, undefined);
  });
  it("requests bounded pages and appends in server order without displaying the lookahead row", async () => {
    mocks.listObjects.mockResolvedValueOnce([object("O11418_10"), object("O11418_2"), object("O11418_3")]).mockResolvedValueOnce([object("O11418_3")]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_10"]')).not.toBeNull());
    expect(mocks.listObjects).toHaveBeenNthCalledWith(1, connection.id, "APP", "APP", undefined, undefined, 3, 0, undefined);
    expect(host.querySelector('[title="O11418_3"]')).toBeNull();
    expect(Array.from(host.querySelectorAll('[title^="O11418_"]')).map((el) => el.getAttribute("title"))).toEqual(["O11418_10", "O11418_2"]);

    const more = host.querySelector<HTMLButtonElement>("[data-object-load-more]");
    expect(more).not.toBeNull();
    more!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_3"]')).not.toBeNull());
    expect(mocks.listObjects).toHaveBeenNthCalledWith(2, connection.id, "APP", "APP", undefined, undefined, 3, 2, undefined);
    expect(host.querySelector("[data-object-load-more]")).toBeNull();
  });

  it("searches beyond loaded rows and resets the page for a type absent from the first page", async () => {
    const matched = { ...object("O11418_LATE_VIEW"), object_type: "VIEW", comment: "n_e_e_d_l_e" };
    mocks.listObjects.mockResolvedValueOnce([object("O11418_1"), object("O11418_2"), object("O11418_3")]).mockResolvedValue([matched]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_1"]')).not.toBeNull());

    await searchObjects(host, "needle");
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_LATE_VIEW"]')).not.toBeNull());
    expect(host.querySelector('[title="O11418_1"]')).toBeNull();
    expect(mocks.listObjects).toHaveBeenNthCalledWith(2, connection.id, "APP", "APP", undefined, "needle", 3, 0, undefined);

    const views = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === "objects.views");
    expect(views).toBeDefined();
    views!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(3));
    expect(mocks.listObjects).toHaveBeenNthCalledWith(3, connection.id, "APP", "APP", ["VIEW"], "needle", 3, 0, undefined);
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_LATE_VIEW"]')).not.toBeNull());
  });

  it("explains unsupported regex without fetching a full object list", async () => {
    mocks.listObjects.mockResolvedValue([object("O11418_1")]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_1"]')).not.toBeNull());
    await searchObjects(host, "/needle/i");
    await vi.waitFor(() => expect(host.textContent).toContain("objects.pagedRegexUnsupported"));
    expect(mocks.listObjects).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[title="O11418_1"]')).toBeNull();
  });

  it("coalesces typing into one bounded request while hiding the old list immediately", async () => {
    mocks.listObjects.mockResolvedValueOnce([object("O11418_OLD")]).mockResolvedValue([object("O11418_NEW")]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_OLD"]')).not.toBeNull());
    await searchObjects(host, "n");
    await searchObjects(host, "needle");
    expect(mocks.listObjects).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[title="O11418_OLD"]')).toBeNull();
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_NEW"]')).not.toBeNull());
    expect(mocks.listObjects).toHaveBeenCalledTimes(2);
    expect(mocks.listObjects.mock.calls[1]?.slice(4, 7)).toEqual(["needle", 3, 0]);
  });

  it.each(["filter", "schema", "refresh"] as const)("ignores a delayed page after %s changes the list", async (change) => {
    let resolveOldPage!: (objects: ObjectInfo[]) => void;
    const oldPage = new Promise<ObjectInfo[]>((resolve) => {
      resolveOldPage = resolve;
    });
    mocks.listObjects
      .mockResolvedValueOnce([object("O11418_1"), object("O11418_2"), object("O11418_3")])
      .mockReturnValueOnce(oldPage)
      .mockResolvedValue([object("O11418_FRESH", change === "schema" ? "OTHER" : "APP")]);
    const { host, schema } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));

    if (change === "filter") await searchObjects(host, "fresh");
    else if (change === "schema") schema.value = "OTHER";
    else host.querySelector<HTMLButtonElement>('[title^="grid.refresh"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_FRESH"]')).not.toBeNull());
    expect(mocks.listObjects.mock.calls[2]?.[6]).toBe(0);
    resolveOldPage([object("O11418_STALE")]);
    await oldPage;
    await nextTick();
    expect(host.querySelector('[title="O11418_STALE"]')).toBeNull();
    expect(host.querySelector('[title="O11418_FRESH"]')).not.toBeNull();
  });

  it("renders an empty final page without retaining a load-more action", async () => {
    mocks.listObjects.mockResolvedValueOnce([object("O11418_1"), object("O11418_2"), object("O11418_3")]).mockResolvedValueOnce([]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).toBeNull());
    expect(host.querySelector('[title="O11418_1"]')).not.toBeNull();
    expect(host.querySelector('[title="O11418_2"]')).not.toBeNull();
  });
});
