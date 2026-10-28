// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { clearObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { clearMetadataRuntimeCache } from "@/lib/metadata/metadataRuntimeCache";
import type { ConnectionConfig, IndexInfo, ObjectInfo } from "@/types/database";

const mocks = vi.hoisted(() => ({ listObjects: vi.fn(), listTables: vi.fn(), listIndexes: vi.fn(), getColumns: vi.fn(), getTableDdl: vi.fn(), openTableStructure: vi.fn(), executeQuery: vi.fn(), executeBatch: vi.fn(), toolbarTier: 0 }));
const ddlSettings = vi.hoisted(() => ({ separateDdlIndexes: false, includeDdlStorage: true, compactDdlSql: false, sidebarMenuLayout: "grouped" }));
vi.mock("@/lib/backend/api", () => ({ ...mocks, listSchemas: vi.fn().mockResolvedValue([" Mixed "]), listObjectStatistics: vi.fn().mockResolvedValue([]), loadSchemaCache: vi.fn().mockResolvedValue(null), saveSchemaCache: vi.fn(), deleteSchemaCachePrefix: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => connection, ensureConnected: vi.fn().mockResolvedValue(undefined), tableNameFilterForScope: () => undefined, orderByPinnedTreeNodes: (rows: unknown[]) => rows }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ openTableStructure: mocks.openTableStructure }) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    desktopSettings: { sidebar_table_page_size: 2 },
    editorSettings: Object.assign(reactive(ddlSettings), { shortcuts: { refreshData: "F5" }, objectBrowserViewMode: "list", objectBrowserShowCheckbox: true, sidebarActivation: "double" }),
    updateEditorSettings: (patch: object) => Object.assign(reactive(ddlSettings), patch),
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useToolbarOverflow", () => ({ useToolbarOverflow: () => ({ tier: ref(mocks.toolbarTier) }) }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup:
      (props, { slots }) =>
      () =>
        h(
          "div",
          props.items.map((item) => slots.default?.({ item })),
        ),
  }),
}));
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: defineComponent({
    props: ["modelValue", "options"],
    emits: ["update:modelValue"],
    setup:
      (props, { emit, attrs }) =>
      () =>
        h(
          "select",
          { ...attrs, value: props.modelValue, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) },
          (props.options ?? []).map((option: string) => h("option", { value: option }, option)),
        ),
  }),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: defineComponent({
    props: ["open"],
    setup:
      (props, { slots }) =>
      () =>
        props.open ? h("div", slots.default?.()) : null,
  }),
  DialogContent: {
    render() {
      return h("div", this.$slots.default?.());
    },
  },
  DialogHeader: {
    render() {
      return h("div", this.$slots.default?.());
    },
  },
  DialogTitle: {
    render() {
      return h("h2", this.$slots.default?.());
    },
  },
  DialogFooter: {
    render() {
      return h("div", this.$slots.default?.());
    },
  },
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({
  default: defineComponent({
    props: ["open"],
    emits: ["confirm"],
    setup:
      (props, { emit }) =>
      () =>
        props.open ? h("button", { "data-danger-confirm": "", onClick: () => emit("confirm") }, "Confirm") : null,
  }),
}));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = { id: "schema-indexes", db_type: "oceanbase-oracle", name: "fixture", database: "service", transport_layers: [] } as unknown as ConnectionConfig;
const mounted: { app: App; host: HTMLElement }[] = [];
const index = (name: string, parentSchema = " Mixed "): ObjectInfo => ({ name, schema: " Mixed ", object_type: "INDEX", parent_schema: parentSchema, parent_name: ' T(a)" ' });
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(reactive(ddlSettings), { separateDdlIndexes: false, includeDdlStorage: true, compactDdlSql: false, sidebarMenuLayout: "grouped" });
  mocks.listObjects.mockReset().mockResolvedValue([]);
  mocks.listTables.mockReset().mockResolvedValue([{ name: ' T(a)" ', table_type: "TABLE" }]);
  mocks.listIndexes.mockReset().mockResolvedValue([{ name: " Ix(a) ", owner: " Mixed ", columns: ["Id"], is_unique: false, is_primary: false }]);
  mocks.getColumns.mockReset().mockResolvedValue([]);
  mocks.getTableDdl.mockReset().mockResolvedValue("CREATE TABLE parent (id NUMBER)");
  connection.db_type = "oceanbase-oracle";
  mocks.toolbarTier = 0;
  clearObjectBrowserRowsCache();
  clearMetadataRuntimeCache();
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
});

async function mountBrowser(extra: Record<string, unknown> = {}) {
  const schema = ref(" Mixed ");
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "service", schema: schema.value, selectedObjectFilter: "indexes", ...extra }) });
  mounted.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalled());
  return { host, schema };
}

describe("schema index browsing and draft navigation", () => {
  it.each(["TABLE", "VIEW"] as const)("applies independent indexes only to table structure exports, not %s sources", async (objectType) => {
    Object.assign(reactive(ddlSettings), { separateDdlIndexes: true, sidebarMenuLayout: "full" });
    mocks.listObjects.mockResolvedValue([{ name: "EXPORT_TARGET", object_type: objectType, schema: " Mixed " }]);
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const { host } = await mountBrowser({ selectedObjectFilter: "all" });
      const row = await vi.waitFor(() => {
        const item = host.querySelector<HTMLElement>('[title="EXPORT_TARGET"]');
        expect(item).not.toBeNull();
        return item!;
      });
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      const action = await vi.waitFor(() => {
        expect(document.querySelector("[data-dbx-context-menu]")).not.toBeNull();
        const item = document.querySelector<HTMLElement>('[data-menu-action="contextMenu.exportStructure"]');
        expect([...document.querySelectorAll("[data-menu-action]")].map((item) => item.getAttribute("data-menu-action"))).toContain("contextMenu.exportStructure");
        return item!;
      });
      action.click();
      await vi.waitFor(() => expect(mocks.getTableDdl).toHaveBeenCalledOnce());
      expect(mocks.getTableDdl.mock.calls[0]).toEqual([connection.id, "service", "Mixed", "EXPORT_TARGET", objectType === "VIEW" ? "VIEW" : undefined, undefined, true, ...(objectType === "TABLE" ? [undefined, true, "Mixed"] : [])]);
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      anchorClick.mockRestore();
    }
  });
  it.each(["oracle", "oceanbase-oracle"] as const)("reloads %s parent DDL with independent indexes without changing exact identity", async (type) => {
    connection.db_type = type;
    mocks.getTableDdl.mockResolvedValueOnce("CREATE TABLE parent (id NUMBER);").mockResolvedValueOnce("CREATE TABLE parent (id NUMBER);\nCREATE INDEX detached ON parent(id);");
    const { host } = await mountBrowser({ initialViewTarget: { schema: " Mixed ", name: " Ix(a) ", parentSchema: " Other Owner ", parentName: ' T(a)" ' }, initialViewRequestId: 1 });
    await vi.waitFor(() => expect(host.querySelector("[data-object-table-info-panel]")).not.toBeNull());
    const ddlTab = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "DDL");
    expect(ddlTab).toBeDefined();
    ddlTab!.click();
    await vi.waitFor(() => expect(mocks.getTableDdl).toHaveBeenCalledTimes(1));
    expect(mocks.getTableDdl.mock.calls[0].slice(0, 6)).toEqual([connection.id, "service", " Other Owner ", ' T(a)" ', undefined, undefined]);
    expect(mocks.getTableDdl.mock.calls[0][7]).toBe(true);
    const option = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>('button[id$="-separateDdlIndexes"]');
      expect(button).not.toBeNull();
      expect(button!.disabled).toBe(false);
      return button!;
    });
    option.click();
    await vi.waitFor(() => expect(mocks.getTableDdl).toHaveBeenCalledTimes(2));
    expect(mocks.getTableDdl.mock.calls[1].slice(0, 6)).toEqual(mocks.getTableDdl.mock.calls[0].slice(0, 6));
    expect(mocks.getTableDdl.mock.calls[1].slice(7)).toEqual([true, true, " Other Owner "]);
    await vi.waitFor(() => expect(host.textContent).toContain("CREATE INDEX detached"));
  });

  it("keeps INDEX selectable in the real overflow menu when the all view is empty", async () => {
    mocks.toolbarTier = 2;
    mocks.listObjects.mockImplementation(async (...args: unknown[]) => (args[10] === true ? [index("EXACT")] : []));
    const { host } = await mountBrowser({ selectedObjectFilter: "all" });
    expect(host.querySelector("[data-object-filter-chips]")).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="toolbar.moreActions"]')!;
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const filter = await vi.waitFor(() => {
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')).find((item) => item.textContent?.trim() === "tree.indexes");
      expect(item).toBeDefined();
      return item!;
    });
    filter.click();
    await vi.waitFor(() => expect(host.querySelector('[title="EXACT"]')).not.toBeNull());
    expect(mocks.listObjects.mock.calls.at(-1)?.slice(3, 7)).toEqual([["INDEX"], undefined, 3, 0]);
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });
  it.each(["empty", "only-indexes"])("keeps the exact INDEX filter clickable from a legacy %s all view", async (kind) => {
    connection.db_type = "oracle";
    mocks.listObjects.mockImplementation(async (...args: unknown[]) => (args[10] === true ? [index("EXACT")] : kind === "empty" ? [] : [index("LEGACY")]));
    const { host } = await mountBrowser({ selectedObjectFilter: "all" });
    const button = await vi.waitFor(() => {
      const filter = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim().startsWith("tree.indexes"));
      expect(filter).toBeDefined();
      return filter!;
    });
    button.click();
    await vi.waitFor(() => expect(host.querySelector('[title="EXACT"]')).not.toBeNull());
    expect(host.querySelector('[title="LEGACY"]')).toBeNull();
    expect(mocks.listObjects.mock.calls.at(-1)?.slice(3, 7)).toEqual([["INDEX"], undefined, 3, 0]);
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });
  it.each(["same", "mixed"])("blocks %s batch deletion containing INDEX rows at the browser entry", async (kind) => {
    mocks.listObjects.mockResolvedValue([index("INDEX_A"), kind === "same" ? index("INDEX_B") : { name: "ORDINARY", object_type: "TABLE", schema: " Mixed " }]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="INDEX_A"]')).not.toBeNull());
    for (const name of ["INDEX_A", kind === "same" ? "INDEX_B" : "ORDINARY"]) {
      host.querySelector(`[title="${name}"]`)!.parentElement!.parentElement!.querySelector<HTMLButtonElement>("button")!.click();
    }
    await nextTick();
    expect(host.textContent).not.toContain("objects.exportSelected");
    expect(host.textContent).not.toContain("objects.copyTableSelected");
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("objects.dropSelected"))!
      .click();
    await nextTick();
    expect(host.querySelector("[data-danger-confirm]")).toBeNull();
    expect(mocks.openTableStructure).not.toHaveBeenCalled();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("keeps %s schema indexes out of the legacy mixed all view", async (type) => {
    connection.db_type = type;
    mocks.listObjects.mockImplementation(async (...args: unknown[]) => (args[10] === true ? [index(" Ix(a) ")] : [{ name: "ORDINARY", schema: " Mixed ", object_type: "TABLE" }, index("LEGACY_WRONG")]));
    const { host } = await mountBrowser({ selectedObjectFilter: "all" });
    await vi.waitFor(() => expect(host.querySelector('[title="ORDINARY"]')).not.toBeNull());
    expect(host.querySelector('[title="ORDINARY"]')).not.toBeNull();
    expect(host.querySelector('[title="LEGACY_WRONG"]')).toBeNull();
    expect(host.querySelector('[title=" Ix(a) "]')).toBeNull();
    expect(mocks.listObjects.mock.calls.every((call) => call[10] !== true && !call[3]?.includes("INDEX"))).toBe(true);
    expect(mocks.listObjects.mock.calls[0][10]).toEqual({ identityMode: "exact" });
  });

  it("loads indexes only after choosing the dedicated bounded exact filter", async () => {
    mocks.listObjects.mockImplementation(async (...args: unknown[]) => {
      if (args[10] !== true) return [{ name: "ORDINARY", object_type: "TABLE", schema: " Mixed " }];
      const all = [index("I1"), index("I2"), index("I3"), index("I4")];
      return all.slice(Number(args[6] ?? 0), Number(args[6] ?? 0) + Number(args[5] ?? all.length));
    });
    const { host } = await mountBrowser({ selectedObjectFilter: "all" });
    await vi.waitFor(() => expect(host.querySelector('[title="ORDINARY"]')).not.toBeNull());
    expect(mocks.listObjects.mock.calls.some((call) => call[10] === true)).toBe(false);
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "tree.indexes")!
      .click();
    await vi.waitFor(() => expect(host.querySelector('[title="I2"]')).not.toBeNull());
    expect(mocks.listObjects.mock.calls.find((call) => call[10] === true)?.slice(5, 7)).toEqual([3, 0]);
    expect(host.querySelector('[title="I3"]')).toBeNull();
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="I4"]')).not.toBeNull());
    expect(mocks.listObjects.mock.calls.filter((call) => call[10] === true)[1]?.slice(5, 7)).toEqual([3, 2]);
    expect(host.querySelectorAll('[title="I1"]')).toHaveLength(1);
    expect(host.querySelector('[title="ORDINARY"]')).toBeNull();
    expect(host.querySelector("[data-object-load-more]")).toBeNull();
  });

  it("keeps ordinary mixed objects available without requesting exact INDEX metadata", async () => {
    connection.db_type = "oracle";
    mocks.listObjects.mockImplementation(async (...args: unknown[]) => {
      if (args[10] === true) throw new Error("exact_metadata_identity_v1 unavailable");
      return [{ name: "ORDINARY", schema: " Mixed ", object_type: "TABLE" }];
    });
    const { host } = await mountBrowser({ selectedObjectFilter: "all" });
    await vi.waitFor(() => expect(host.querySelector('[title="ORDINARY"]')).not.toBeNull());
    expect(host.textContent).not.toContain("exact_metadata_identity_v1 unavailable");
    expect(mocks.listObjects).toHaveBeenCalledTimes(1);
  });

  it("retains selected indexes across append and refresh, but removes disappeared selections", async () => {
    let indexes = [index("I1"), index("I2"), index("I3"), index("I4")];
    mocks.listObjects.mockImplementation(async (...args: unknown[]) => indexes.slice(Number(args[6] ?? 0), Number(args[6] ?? 0) + Number(args[5] ?? indexes.length)));
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="I2"]')).not.toBeNull());
    host.querySelector('[title="I1"]')!.parentElement!.parentElement!.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick();
    expect(host.textContent).toContain("objects.dropSelected");
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="I4"]')).not.toBeNull());
    expect(host.textContent).toContain("objects.dropSelected");
    host.querySelector<HTMLButtonElement>('[title^="grid.refresh"]')!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(3));
    await nextTick();
    expect(host.textContent).toContain("objects.dropSelected");
    indexes = indexes.filter((object) => object.name !== "I1");
    host.querySelector<HTMLButtonElement>('[title^="grid.refresh"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="I1"]')).toBeNull());
    expect(host.textContent).not.toContain("objects.dropSelected");
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("%s requests exact typed pages before rendering INDEX rows", async (type) => {
    connection.db_type = type;
    mocks.listObjects.mockResolvedValue([index(" Ix(a) "), index("IX_A_2"), index("third")]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title=" Ix(a) "]')).not.toBeNull());
    expect(mocks.listObjects).toHaveBeenCalledExactlyOnceWith(connection.id, "service", " Mixed ", ["INDEX"], undefined, 3, 0, undefined, undefined, undefined, true);
    expect(host.querySelector('[title="third"]')).toBeNull();
    expect(host.querySelector("[data-object-load-more]")).not.toBeNull();
  });

  it.each(["insert", "delete"] as const)("refreshes the displayed exact index range after a concurrent %s moves its page anchor", async (change) => {
    const first = [index("I1"), index("I2"), index("I3")];
    const shifted = change === "insert" ? [index("I2"), index("I3"), index("I4")] : [index("I4")];
    const refreshed = change === "insert" ? [index("I0"), ...first, index("I4")] : [index("I2"), index("I3"), index("I4")];
    mocks.listObjects.mockResolvedValueOnce(first).mockResolvedValueOnce(shifted).mockResolvedValueOnce(refreshed);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="I2"]')).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(3));
    expect(mocks.listObjects.mock.calls[2]?.slice(5, 7)).toEqual([5, 0]);
    const visible = refreshed.slice(0, 4).map((object) => object.name);
    await vi.waitFor(() => expect(Array.from(host.querySelectorAll('[title^="I"]')).map((element) => element.getAttribute("title"))).toEqual(visible));
    expect(host.querySelector("[data-object-load-more]") !== null).toBe(change === "insert");
  });

  it("retains the applicable index list after a failed manual refresh and permits retry", async () => {
    mocks.listObjects
      .mockResolvedValueOnce([index("KEPT")])
      .mockRejectedValueOnce(new Error("index dictionary denied"))
      .mockResolvedValueOnce([index("FRESH")]);
    const { host } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="KEPT"]')).not.toBeNull());
    host.querySelector<HTMLButtonElement>('[title^="grid.refresh"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toContain("index dictionary denied"));
    expect(host.querySelector('[title="KEPT"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('[title^="grid.refresh"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('[title="FRESH"]')).not.toBeNull());
    expect(host.querySelector('[title="KEPT"]')).toBeNull();
    expect(host.textContent).not.toContain("index dictionary denied");
  });

  it("creates from an empty index list by choosing an exact visible TABLE, with no DDL", async () => {
    const { host } = await mountBrowser();
    const create = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>("[data-create-schema-index]");
      expect(button).not.toBeNull();
      return button!;
    });
    create.click();
    await vi.waitFor(() => expect(mocks.listTables).toHaveBeenCalledExactlyOnceWith(connection.id, "service", " Mixed ", undefined, undefined, undefined, ["TABLE"], undefined, undefined, true));
    const select = host.querySelector<HTMLSelectElement>("[data-index-parent-table]")!;
    await vi.waitFor(() => expect([...select.options].some((option) => option.value === ' T(a)" ')).toBe(true));
    select.value = ' T(a)" ';
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-confirm-index-parent]")!.click();
    expect(mocks.openTableStructure).toHaveBeenCalledExactlyOnceWith(connection.id, "service", " Mixed ", ' T(a)" ', "indexes", { kind: "index", name: "", action: "create" }, undefined, "table", true);
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it.each(["empty", "loading", "failed"])("a direct cross-owner view request reads the parent with a %s list and never edits", async (state) => {
    if (state === "loading") mocks.listObjects.mockReturnValue(new Promise(() => {}));
    if (state === "failed") mocks.listObjects.mockRejectedValue(new Error("central list unavailable"));
    const target = { schema: " Mixed ", name: " Ix(a) ", parentSchema: " Other Owner ", parentName: ' T(a)" ' };
    const { host } = await mountBrowser({ initialViewTarget: target, initialViewRequestId: 1 });
    await vi.waitFor(() => expect(mocks.listIndexes).toHaveBeenCalledExactlyOnceWith(connection.id, "service", " Other Owner ", ' T(a)" ', undefined, true));
    expect(host.querySelector("[data-object-table-info-panel]")).not.toBeNull();
    expect(host.querySelector("[data-object-table-structure]")).toBeNull();
    expect(mocks.openTableStructure).not.toHaveBeenCalled();
  });

  it("changing schema retires a pending table picker, without opening a stale draft", async () => {
    let resolve!: (value: unknown[]) => void;
    mocks.listTables.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { host, schema } = await mountBrowser();
    const create = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>("[data-create-schema-index]");
      expect(button).not.toBeNull();
      return button!;
    });
    create.click();
    await vi.waitFor(() => expect(mocks.listTables).toHaveBeenCalledOnce());
    schema.value = "OTHER";
    await nextTick();
    resolve([{ name: "STALE", table_type: "TABLE" }]);
    await nextTick();
    expect(host.querySelector("[data-confirm-index-parent]")).toBeNull();
    expect(mocks.openTableStructure).not.toHaveBeenCalled();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it("retries a failed parent read and permits cancelling without creating a draft", async () => {
    mocks.listTables.mockRejectedValueOnce(new Error("exact metadata unavailable"));
    const { host } = await mountBrowser();
    host.querySelector<HTMLButtonElement>("[data-create-schema-index]")!.click();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("exact metadata unavailable"));
    expect(host.querySelector<HTMLButtonElement>("[data-confirm-index-parent]")!.disabled).toBe(true);
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "common.retry")!
      .click();
    await vi.waitFor(() => expect(mocks.listTables).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).toBeNull());
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "common.cancel")!
      .click();
    await nextTick();
    expect(host.querySelector("[data-confirm-index-parent]")).toBeNull();
    expect(mocks.openTableStructure).not.toHaveBeenCalled();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it.each([false, true])("ignores a late exact INDEX page after changing Schema (failed: %s)", async (failed) => {
    let release!: (value: ObjectInfo[]) => void;
    let reject!: (error: Error) => void;
    mocks.listObjects.mockResolvedValueOnce([index("FIRST"), index("SECOND"), index("LOOKAHEAD")]);
    mocks.listObjects.mockImplementationOnce(
      () =>
        new Promise<ObjectInfo[]>((resolve, fail) => {
          release = resolve;
          reject = fail;
        }),
    );
    mocks.listObjects.mockResolvedValue([{ ...index("CURRENT", "OTHER"), schema: "OTHER" }]);
    const { host, schema } = await mountBrowser();
    await vi.waitFor(() => expect(host.querySelector('[title="SECOND"]')).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-object-load-more]")!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    expect(mocks.listObjects.mock.calls[1]?.slice(5, 7)).toEqual([3, 2]);
    schema.value = "OTHER";
    await vi.waitFor(() => expect(host.querySelector('[title="CURRENT"]')).not.toBeNull());
    if (failed) reject(new Error("retired page failure"));
    else release([index("STALE")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelector('[title="CURRENT"]')).not.toBeNull();
    expect(host.querySelector('[title="STALE"]')).toBeNull();
    expect(host.textContent).not.toContain("retired page failure");
  });

  it("shows parent indexes without a false match when index owner is absent", async () => {
    mocks.listIndexes.mockResolvedValue([{ name: " Ix(a) ", columns: ["Id"], is_unique: false, is_primary: false }]);
    const { host } = await mountBrowser({ initialViewTarget: { schema: " Mixed ", name: " Ix(a) ", parentSchema: " Other Owner ", parentName: ' T(a)" ' }, initialViewRequestId: 1 });
    await vi.waitFor(() => expect(host.querySelector("[data-schema-index-focus-unavailable]")).not.toBeNull());
    expect(host.querySelector("[data-schema-index-match]")).toBeNull();
    expect(host.querySelector("[data-object-table-structure]")).toBeNull();
    expect(mocks.openTableStructure).not.toHaveBeenCalled();
  });

  it("focuses only the exact dictionary owner among same-name parent indexes", async () => {
    const indexes: IndexInfo[] = [" Mixed ", "Other"].map((owner) => ({ name: " Ix(a) ", owner, columns: ["Id"], is_unique: false, is_primary: false }));
    mocks.listIndexes.mockResolvedValue(indexes);
    const { host } = await mountBrowser({ initialViewTarget: { schema: " Mixed ", name: " Ix(a) ", parentSchema: " Other Owner ", parentName: ' T(a)" ' }, initialViewRequestId: 1 });
    await vi.waitFor(() => expect(host.querySelectorAll("[data-schema-index-match]")).toHaveLength(1));
    expect(host.querySelector("[data-schema-index-focus-unavailable]")).toBeNull();
    expect(mocks.openTableStructure).not.toHaveBeenCalled();
  });
});
