// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig, ObjectBrowserFilter, ObjectInfo } from "@/types/database";

const mocks = vi.hoisted(() => ({ listObjects: vi.fn(), listSchemas: vi.fn(), getObjectSource: vi.fn(), listSchemaIndexes: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => (args[10] === true ? mocks.listSchemaIndexes(...args) : mocks.listObjects(...args)),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  getObjectSource: (...args: unknown[]) => mocks.getObjectSource(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: () => connection, connectedIds: new Set([connection.id]), connectionStateRevision: () => 0, ensureConnected: vi.fn().mockResolvedValue(undefined), tableNameFilterForScope: () => undefined, orderByPinnedTreeNodes: (rows: unknown[]) => rows }),
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
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: defineComponent({ props: { modelValue: String }, setup: (props) => () => h("pre", { "data-source-text": "" }, props.modelValue) }) }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = { id: "ob-11418-pages", name: "OceanBase Oracle", db_type: "oceanbase-oracle", database: "APP", driver_profile: null, url_params: null, transport_layers: [] } as unknown as ConnectionConfig;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];
const object = (name: string, schema = "APP"): ObjectInfo => ({ name, schema, object_type: "TABLE", comment: "业务 Needle 100%_" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listObjects.mockReset();
  mocks.getObjectSource.mockReset();
  mocks.listSchemas.mockReset().mockResolvedValue(["APP", "OTHER"]);
  invalidateObjectBrowserRowsCache({});
});
afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountBrowser(selectedObjectFilter: ObjectBrowserFilter | null = "all", catalog?: string, config = connection) {
  const schema = ref("APP");
  const selectedCatalog = ref(catalog);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection: config, database: "APP", schema: schema.value, catalog: selectedCatalog.value, selectedObjectFilter: selectedObjectFilter ?? undefined }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalled());
  return { host, schema, catalog: selectedCatalog };
}

async function searchObjects(host: HTMLElement, query: string) {
  const input = host.querySelector<HTMLInputElement>("[data-object-search-input]")!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

describe("OceanBase Oracle object pagination (#11418)", () => {
  const triggerObject = (name: string, id = name): ObjectInfo => ({
    name,
    schema: " Raw Owner ",
    object_type: "TRIGGER",
    trigger: { name, timing: "BEFORE", event: "UPDATE", oracle_metadata: { contractVersion: 1, identityMode: "exact", engine: "oracle", owner: " Raw Owner ", name, objectId: id, scope: "SCHEMA", scopeOwner: " Raw Owner ", reads: { identity: { state: "available" } } } },
  });

  it.each(["oracle", "dameng", "jdbc"] as const)("starts explicit %s trigger discovery with bounded exact pages", async (db_type) => {
    const config = { ...connection, db_type, ...(db_type === "jdbc" ? { driver_profile: "oracle", database_info: { productName: "Oracle" } } : {}) } as ConnectionConfig;
    mocks.listObjects.mockResolvedValue([triggerObject(' Tr"g ')]);
    const { host } = await mountBrowser("triggers", " Catalog ", config);
    await vi.waitFor(() => expect(host.querySelector("[title=' Tr\"g ']")).not.toBeNull());
    expect(mocks.listObjects).toHaveBeenNthCalledWith(1, config.id, "APP", "APP", ["TRIGGER"], undefined, 3, 0, " Catalog ", undefined, undefined, { identityMode: "exact", catalog: " Catalog " });
  });

  it("reloads the legacy all list after leaving native trigger paging", async () => {
    mocks.listObjects.mockResolvedValueOnce([triggerObject("ONLY_TRIGGER")]).mockResolvedValueOnce([object("LEGACY_TABLE"), triggerObject("ONLY_TRIGGER")]);
    const { host } = await mountBrowser("triggers", undefined, { ...connection, db_type: "oracle" });
    await vi.waitFor(() => expect(host.querySelector('[title="ONLY_TRIGGER"]')).not.toBeNull());
    [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "objects.all")!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="LEGACY_TABLE"]')).not.toBeNull());
    expect(mocks.listObjects.mock.calls[1]?.[3]).not.toContain("INDEX");
    expect(mocks.listObjects.mock.calls[1]?.[3]).toContain("TRIGGER");
    expect(mocks.listObjects.mock.calls[1]?.slice(4, 8)).toEqual([undefined, undefined, undefined, undefined]);
    expect(mocks.listObjects.mock.calls[1]?.[10]).toEqual({ identityMode: "exact" });
  });

  it.each(["oracle", "dameng"] as const)("preserves the %s default full-list read and offers trigger discovery even when empty", async (db_type) => {
    mocks.listObjects.mockResolvedValueOnce([object("LEGACY_TABLE")]).mockResolvedValueOnce([]);
    const { host } = await mountBrowser(null, undefined, { ...connection, db_type });
    await vi.waitFor(() => expect(host.querySelector('[title="LEGACY_TABLE"]')).not.toBeNull());
    expect(mocks.listObjects.mock.calls[0]?.[3]).not.toContain("INDEX");
    expect(mocks.listObjects.mock.calls[0]?.[3]).toContain("TRIGGER");
    expect(mocks.listObjects.mock.calls[0]?.slice(4, 7)).toEqual([undefined, undefined, undefined]);
    expect(mocks.listObjects.mock.calls[0]?.[10]).toEqual({ identityMode: "exact" });
    const triggers = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim().startsWith("tree.triggers"));
    expect(triggers).toBeDefined();
    triggers!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    expect(mocks.listObjects.mock.calls[1]?.slice(3, 7)).toEqual([["TRIGGER"], undefined, 3, 0]);
    await vi.waitFor(() => expect([...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "contextMenu.createTrigger")).toBe(true));
  });

  it("discards a delayed native trigger page after returning to legacy all", async () => {
    let resolve!: (objects: ObjectInfo[]) => void;
    mocks.listObjects
      .mockResolvedValueOnce([triggerObject("A"), triggerObject("B"), triggerObject("C")])
      .mockReturnValueOnce(
        new Promise<ObjectInfo[]>((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValueOnce([object("LEGACY_TABLE")]);
    const { host } = await mountBrowser("triggers", undefined, { ...connection, db_type: "oracle" });
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "objects.all")!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="LEGACY_TABLE"]')).not.toBeNull());
    resolve([triggerObject("C")]);
    await nextTick();
    expect(host.querySelector('[title="C"]')).toBeNull();
    expect(host.querySelector('[title="LEGACY_TABLE"]')).not.toBeNull();
    expect(host.querySelector("[data-object-load-more]")).toBeNull();
  });

  it("reloads the exact trigger list when only the catalog changes and ignores its old page", async () => {
    let resolve!: (objects: ObjectInfo[]) => void;
    mocks.listObjects
      .mockResolvedValueOnce([triggerObject("A"), triggerObject("B"), triggerObject("C")])
      .mockReturnValueOnce(
        new Promise<ObjectInfo[]>((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValueOnce([triggerObject("NEW_CATALOG")]);
    const { host, catalog } = await mountBrowser("triggers", " Old Catalog ");
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    catalog.value = " New Catalog ";
    await vi.waitFor(() => expect(host.querySelector('[title="NEW_CATALOG"]')).not.toBeNull());
    expect(mocks.listObjects.mock.calls[2]?.[7]).toBe(" New Catalog ");
    expect(mocks.listObjects.mock.calls[2]?.[10]).toEqual({ identityMode: "exact", catalog: " New Catalog " });
    resolve([triggerObject("C")]);
    await nextTick();
    expect(host.querySelector('[title="C"]')).toBeNull();
  });

  it("keeps the old window and retries read-only after a drift reread fails", async () => {
    mocks.listObjects
      .mockResolvedValueOnce([triggerObject("A"), triggerObject("B"), triggerObject("C")])
      .mockResolvedValueOnce([triggerObject("CHANGED")])
      .mockRejectedValueOnce(new Error("window reread denied"))
      .mockResolvedValueOnce([triggerObject("C")]);
    const { host } = await mountBrowser("triggers");
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(host.textContent).toContain("window reread denied"));
    expect(host.querySelector('[title="A"]')).not.toBeNull();
    expect(host.querySelector('[title="B"]')).not.toBeNull();
    expect(host.querySelector('[title="CHANGED"]')).toBeNull();
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="C"]')).not.toBeNull());
    expect(mocks.listObjects.mock.calls[3]?.slice(5, 7)).toEqual([3, 2]);
    expect(host.textContent).not.toContain("window reread denied");
  });

  it.each(["object-id", "quoted-name", "empty"])("replaces a shifted trigger page window instead of appending (%s)", async (change) => {
    const a = triggerObject("A"),
      b = triggerObject("B"),
      peek = triggerObject(' Quoted"Name ', "9007199254740993");
    const changed = triggerObject(change === "quoted-name" ? ' quoted"Name ' : peek.name, change === "object-id" ? "9007199254740994" : peek.trigger!.oracle_metadata!.objectId!);
    mocks.listObjects
      .mockResolvedValueOnce([a, b, peek])
      .mockResolvedValueOnce(change === "empty" ? [] : [changed])
      .mockResolvedValueOnce(change === "empty" ? [a] : [a, b, changed]);
    const { host } = await mountBrowser("triggers");
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(3));
    expect(mocks.listObjects.mock.calls[2]?.slice(5, 7)).toEqual([5, 0]);
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).toBeNull());
    expect(host.querySelector('[title="A"]')).not.toBeNull();
    expect(host.querySelector('[title="B"]') !== null).toBe(change !== "empty");
  });

  it("keeps the visible paged list while refreshing and after refresh failure", async () => {
    let reject!: (error: Error) => void;
    mocks.listObjects.mockResolvedValueOnce([object("KEEP_VISIBLE")]).mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="KEEP_VISIBLE"]')).not.toBeNull());
    host.querySelector<HTMLButtonElement>('[title^="grid.refresh"]')!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    expect(host.querySelector('[title="KEEP_VISIBLE"]')).not.toBeNull();
    reject(new Error("refresh permission denied"));
    await vi.waitFor(() => expect(host.textContent).toContain("refresh permission denied"));
    expect(host.querySelector('[title="KEEP_VISIBLE"]')).not.toBeNull();
  });

  it("opens the existing source editor to create the first trigger from an empty trigger filter", async () => {
    mocks.listObjects.mockResolvedValue([]);
    const { host } = await mountBrowser("triggers", "Catalog");
    const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "contextMenu.createTrigger");
    expect(create).toBeDefined();
    create!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("[data-trigger-create-name]")?.value).toBe("TRG_NEW"));
    expect(document.querySelector<HTMLInputElement>("[data-trigger-create-owner]")?.value).toBe("APP");
    expect(mocks.getObjectSource).not.toHaveBeenCalled();
  });

  it("opens a raw cross-owner trigger with exact source options from the existing object row", async () => {
    const trigger = {
      name: " Trigger ",
      event: "UPDATE",
      timing: "BEFORE",
      enabled: true,
      valid: false,
      oracle_metadata: {
        contractVersion: 1,
        identityMode: "exact",
        engine: "oceanbase-oracle",
        owner: " Trigger Owner ",
        name: " Trigger ",
        scope: "VIEW",
        objectId: "9007199254740993",
        parent: { owner: " Parent Owner ", name: " Parent ", objectType: "VIEW" },
        reads: { identity: { state: "available" } },
      },
    };
    const source = 'TRIGGER " Trigger " BEFORE UPDATE ON " Parent Owner "." Parent " BEGIN /* ' + "中文😀".repeat(12_000) + " */ NULL; END;";
    mocks.listObjects.mockResolvedValue([{ name: trigger.name, schema: " Trigger Owner ", object_type: "TRIGGER", trigger }]);
    mocks.getObjectSource.mockResolvedValue({ name: trigger.name, schema: " Trigger Owner ", object_type: "TRIGGER", source, trigger });
    const { host } = await mountBrowser("triggers", " Catalog ");
    await vi.waitFor(() => expect(host.querySelector('[title=" Trigger "]')).not.toBeNull());
    const row = host.querySelector('[title=" Trigger "]')!.closest(".grid")!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalled());
    expect(mocks.listObjects.mock.calls[0][10]).toEqual({ identityMode: "exact", catalog: " Catalog " });
    expect(mocks.getObjectSource).toHaveBeenCalledWith(connection.id, "APP", " Trigger Owner ", " Trigger ", "TRIGGER", undefined, undefined, { identityMode: "exact", catalog: " Catalog " });
    await vi.waitFor(() => expect(host.querySelector("[data-source-text]")?.textContent).toBe(source));
    expect(Array.from(host.querySelectorAll("button")).some((button) => button.textContent?.trim() === "tree.triggers")).toBe(true);
    mocks.getObjectSource.mockRejectedValue(new Error("metadata temporarily offline"));
    const discard = vi.fn(() => false);
    vi.stubGlobal("confirm", discard);
    const refresh = host.querySelector<HTMLButtonElement>('[aria-label="structureEditor.refresh"]')!;
    refresh.click();
    await vi.waitFor(() => expect(host.textContent).toContain("metadata temporarily offline"));
    refresh.click();
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledTimes(3));
    await nextTick();
    await vi.waitFor(() => expect(refresh.disabled).toBe(false));
    expect(discard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(host.querySelector("[data-source-text]")?.textContent === source).toBe(true));
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "objects.saveSource")!
      .click();
    await vi.waitFor(() => expect(host.textContent?.includes("oracleTrigger.reloadBaseline")).toBe(true));
  });

  it("ends local waiting when the object request never returns", async () => {
    vi.useFakeTimers();
    mocks.listObjects.mockReturnValue(new Promise(() => undefined));
    const { host } = await mountBrowser();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(host.textContent).toContain("timed out");
  });

  it("releases a stalled schema wait and clears its timer on unmount", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.listSchemas.mockReturnValueOnce(new Promise(() => undefined));
    mocks.listObjects.mockResolvedValue([object("CURRENT")]);
    const { host } = await mountBrowser();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(host.querySelector('[title="CURRENT"]')).not.toBeNull();
    expect(warning).toHaveBeenCalled();
    const mounted = mountedApps.pop()!;
    mounted.app.unmount();
    mounted.host.remove();
    expect(vi.getTimerCount()).toBe(0);
    warning.mockRestore();
  });

  it("starts the default table tab with a typed request", async () => {
    mocks.listObjects.mockResolvedValue([object("O11418_1")]);
    await mountBrowser(null);
    expect(mocks.listObjects).toHaveBeenCalledWith(connection.id, "APP", "APP", ["TABLE"], undefined, 3, 0, undefined);
  });
  it("offers the types filter before any types are loaded and requests both specifications and bodies", async () => {
    mocks.listObjects.mockResolvedValueOnce([object("FIRST_TABLE")]).mockResolvedValue([
      { ...object("CUSTOM_TYPE"), object_type: "TYPE" },
      { ...object("CUSTOM_TYPE_BODY"), object_type: "TYPE_BODY" },
    ]);
    const { host } = await mountBrowser();
    const types = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === "tree.types");
    expect(types).toBeDefined();
    types!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    expect(mocks.listObjects).toHaveBeenLastCalledWith(connection.id, "APP", "APP", ["TYPE", "TYPE_BODY"], undefined, 3, 0, undefined);
    await vi.waitFor(() => expect(host.querySelector('[title="CUSTOM_TYPE"]')).not.toBeNull());
    expect(host.querySelector('[title="CUSTOM_TYPE_BODY"]')).not.toBeNull();
    expect(host.querySelector('[title="FIRST_TABLE"]')).toBeNull();
  });
  it("requests bounded pages and appends in server order without displaying the lookahead row", async () => {
    mocks.listObjects.mockResolvedValueOnce([object("O11418_10"), object("O11418_2"), object("O11418_3")]).mockResolvedValueOnce([object("O11418_3")]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_10"]')).not.toBeNull());
    expect(mocks.listObjects).toHaveBeenNthCalledWith(1, connection.id, "APP", "APP", expect.not.arrayContaining(["INDEX"]), undefined, 3, 0, undefined, undefined, undefined, { identityMode: "exact" });
    expect(host.querySelector('[title="O11418_3"]')).toBeNull();
    expect(Array.from(host.querySelectorAll('[title^="O11418_"]')).map((el) => el.getAttribute("title"))).toEqual(["O11418_10", "O11418_2"]);

    const more = host.querySelector<HTMLButtonElement>("[data-object-load-more]");
    expect(more).not.toBeNull();
    more!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="O11418_3"]')).not.toBeNull());
    expect(mocks.listObjects).toHaveBeenNthCalledWith(2, connection.id, "APP", "APP", expect.not.arrayContaining(["INDEX"]), undefined, 3, 2, undefined, undefined, undefined, { identityMode: "exact" });
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
    expect(mocks.listObjects).toHaveBeenNthCalledWith(2, connection.id, "APP", "APP", expect.not.arrayContaining(["INDEX"]), "needle", 3, 0, undefined, undefined, undefined, { identityMode: "exact" });

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
    mocks.listObjects
      .mockResolvedValueOnce([object("O11418_1"), object("O11418_2"), object("O11418_3")])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([object("O11418_1"), object("O11418_2")]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(host.querySelector("[data-object-load-more]")).toBeNull());
    expect(host.querySelector('[title="O11418_1"]')).not.toBeNull();
    expect(host.querySelector('[title="O11418_2"]')).not.toBeNull();
    expect(mocks.listObjects.mock.calls.at(-1)?.slice(5, 7)).toEqual([5, 0]);
  });
});
