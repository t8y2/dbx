// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { invalidateMetadataRuntimeCachePrefix } from "@/lib/metadata/metadataRuntimeCache";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({ listConstraints: vi.fn(), getTableComment: vi.fn(), getTablePartitionStatus: vi.fn(), getTablePartitioning: vi.fn(), toast: vi.fn(), executeQuery: vi.fn(), cancelQuery: vi.fn(async () => true) }));
vi.mock("@/lib/backend/api", () => ({
  listObjects: vi.fn().mockResolvedValue([{ name: "O01_CONSTRAINTS", object_type: "TABLE", schema: "TESTER" }]),
  listSchemas: vi.fn().mockResolvedValue(["TESTER"]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getTableDisplayDdl: vi.fn().mockResolvedValue("CREATE TABLE O01_CONSTRAINTS (A NUMBER, B NUMBER)"),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  listConstraints: (...args: unknown[]) => mocks.listConstraints(...args),
  getTableComment: (...args: unknown[]) => mocks.getTableComment(...args),
  getTablePartitionStatus: (...args: unknown[]) => mocks.getTablePartitionStatus(...args),
  getTablePartitioning: (...args: unknown[]) => mocks.getTablePartitioning(...args),
  executeQuery: (...args: unknown[]) => mocks.executeQuery(...args),
  cancelQuery: (...args: unknown[]) => mocks.cancelQuery(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => connection,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
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
      sidebarActivation: "double",
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
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
  connection.db_type = "oceanbase-oracle";
  connection.query_timeout_secs = undefined;
  mocks.getTableComment.mockReset().mockResolvedValue(null);
  mocks.getTablePartitionStatus.mockReset().mockResolvedValue({ isPartitionedParent: true, isPartition: false });
  mocks.getTablePartitioning.mockReset().mockResolvedValue(null);
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
  vi.useRealTimers();
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
  it("consumes a captured relation-property request without fetching table data or entering a source editor", async () => {
    mocks.executeQuery.mockResolvedValue({
      columns: ["DIRECTION", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"],
      rows: [["REFERENCED_BY", "Other.Owner", "Uses.Table", "FUNCTION", "TESTER", "Mixed.Table", "TABLE", "HARD", null]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const consumed = vi.fn(),
      onOpenDependencyObject = vi.fn();
    const app = createApp(ObjectBrowser, {
      connection,
      database: "TESTER",
      schema: "TESTER",
      propertyRequest: { requestId: "request-1", connectionId: connection.id, database: "TESTER", schema: "TESTER", name: "Mixed.Table", objectType: "TABLE", initialTab: "relations" },
      onPropertyRequestConsumed: consumed,
      onOpenDependencyObject,
    });
    mountedApps.push({ app, host });
    app.mount(host);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(1));
    expect(mocks.executeQuery.mock.calls[0]).toEqual([connection.id, "TESTER", expect.stringContaining("ALL_DEPENDENCIES"), "TESTER", expect.any(String), { catalog: undefined }]);
    expect(consumed).toHaveBeenCalledWith("request-1");
    expect(host.querySelector("[data-object-source-editor]")).toBeNull();
    expect(host.querySelector('[data-object-section="source"]')).toBeNull();
    expect(mocks.getTablePartitionStatus).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('[data-object-section="dependents"]')!.click();
    await vi.waitFor(() => expect([...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Uses.Table")).toBeDefined());
    [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Uses.Table")!.click();
    expect(onOpenDependencyObject).toHaveBeenCalledWith(expect.objectContaining({ connectionId: connection.id, database: "TESTER", schema: "TESTER", name: "Mixed.Table" }), { name: "Uses.Table", schema: "Other.Owner", type: "function", nameQuoted: true, schemaQuoted: true });
  });

  it.each([120, 0])("keeps a constraint request alive beyond 35 seconds with timeout %s", async (timeout) => {
    vi.useFakeTimers();
    connection.query_timeout_secs = timeout;
    let resolve!: (rows: unknown[]) => void;
    mocks.listConstraints.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const host = await openConstraints();
    await vi.waitFor(() => expect(mocks.listConstraints).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(40_000);
    resolve([{ name: "SLOW_CONSTRAINT", constraint_type: "UNIQUE", definition: "UNIQUE (A)", columns: ["A"], ref_columns: [], enabled: true, valid: true }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.textContent).toContain("SLOW_CONSTRAINT");
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringContaining("Metadata loading timed out"), 5000);
  });

  it("reads a requested index relation rather than substituting its parent table", async () => {
    mocks.executeQuery.mockResolvedValue({ columns: ["CHILD_OWNER", "CHILD_NAME", "CHILD_TYPE", "PARENT_OWNER", "PARENT_NAME", "PARENT_TYPE"], rows: [["Index.Owner", "Idx.Dot", "INDEX", "TESTER", "Parent.Table", "TABLE"]], affected_rows: 0, execution_time_ms: 1 });
    const host = document.createElement("div");
    document.body.append(host);
    const consumed = vi.fn();
    const app = createApp(ObjectBrowser, {
      connection,
      database: "TESTER",
      schema: "TESTER",
      propertyRequest: { requestId: "index-request", connectionId: connection.id, database: "TESTER", schema: "TESTER", name: "Parent.Table", objectType: "TABLE", initialTab: "relations", focusObject: { owner: "Index.Owner", name: "Idx.Dot", type: "INDEX" } },
      onPropertyRequestConsumed: consumed,
    });
    mountedApps.push({ app, host });
    app.mount(host);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(1));
    const [connectionId, database, sql, schema] = mocks.executeQuery.mock.calls[0]!;
    expect([connectionId, database, schema]).toEqual([connection.id, "TESTER", "Index.Owner"]);
    expect(sql).toContain("i.OWNER = 'Index.Owner' AND i.INDEX_NAME = 'Idx.Dot'");
    expect(host.textContent).toContain("Index.Owner.Idx.Dot");
    expect(host.querySelector('[data-object-section="foreignKeys"]')).toBeNull();
    expect(consumed).toHaveBeenCalledWith("index-request");
  });
  it.each(["overview", "partitions"])("ends a stalled %s metadata wait through the actual detail tab", async (kind) => {
    // Partition tabs are currently PostgreSQL-only; keep their shared lifecycle bounded too.
    if (kind === "partitions") connection.db_type = "postgres";
    const host = await openConstraints();
    vi.useFakeTimers();
    const stalled = kind === "overview" ? mocks.getTableComment : mocks.getTablePartitioning;
    stalled.mockReturnValueOnce(new Promise(() => undefined));
    const title = kind === "overview" ? "grid.tableInfoOverview" : "structureEditor.partitions";
    host.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!.click();
    await vi.advanceTimersByTimeAsync(35_001);
    expect(stalled).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("Metadata loading timed out"), 5000);
  });
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
