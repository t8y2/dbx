// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { loadLocaleMessages } from "@/i18n";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useTableCopyTaskStore } from "@/stores/tableCopyTaskStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import * as api from "@/lib/backend/api";
import { OraclePackageSaveAsFailure, type OraclePackageSaveAsPlan } from "@/lib/table/oraclePackageSaveAs";

const backend = vi.hoisted(() => ({ executeQuery: vi.fn(), executeConditionalUpdate: vi.fn(), buildDuplicateTableStructureSql: vi.fn(), buildCreateTableSql: vi.fn(), buildCopyTableDataSql: vi.fn() }));
const packageSaveAs = vi.hoisted(() => ({ prepare: vi.fn(), prepareExecution: vi.fn(), execute: vi.fn(), dispose: vi.fn() }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  ...backend,
  closeClientConnectionSession: vi.fn().mockResolvedValue(true),
  listPlugins: vi.fn().mockResolvedValue([]),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  saveConnectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
  listSchemas: vi.fn().mockResolvedValue(["APP"]),
  listDatabases: vi.fn().mockResolvedValue(["APP"]),
  listObjects: vi.fn().mockResolvedValue([{ name: "SOURCE", object_type: "TABLE", schema: "APP" }]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getColumns: vi.fn().mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null }]),
  listConstraints: vi.fn().mockResolvedValue([]),
  listIndexes: vi.fn().mockResolvedValue([]),
  listTriggers: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/table/oraclePackageSaveAs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/table/oraclePackageSaveAs")>();
  return { ...actual, prepareOraclePackageSaveAs: (...args: unknown[]) => packageSaveAs.prepare(...args), prepareOraclePackageSaveAsExecution: (...args: unknown[]) => packageSaveAs.prepareExecution(...args) };
});

const result = (rows: unknown[][] = []) => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });
const connection = { id: "ob-entry", name: "OB", db_type: "oceanbase-oracle", driver_profile: "oceanbase-oracle", host: "test", port: 2881, username: "APP", database: "APP" } as ConnectionConfig;
const source: TreeNode = { id: "ob-entry:APP:APP:table:SOURCE", type: "table", label: "SOURCE", connectionId: connection.id, database: "APP", schema: "APP" };
const mounted: App[] = [];
const auxiliaryRequests = new Set<string>();
const ddlCalls = () => backend.executeQuery.mock.calls.filter((call) => !String(call[2]).startsWith("SELECT "));

beforeEach(() => {
  vi.clearAllMocks();
  i18n.global.locale.value = "en";
  vi.mocked(api.listIndexes).mockResolvedValue([]);
  connection.is_production = false;
  invalidateObjectBrowserRowsCache({});
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
  vi.stubGlobal("alert", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      auxiliaryRequests.add(String(input));
      throw new Error(`Unexpected HTTP request: ${input}`);
    }),
  );
  backend.buildCreateTableSql.mockImplementation(async ({ schema, tableName }) => ({ statements: [`CREATE TABLE "${schema}"."${tableName}" ("ID" NUMBER);`], warnings: [] }));
  backend.buildCopyTableDataSql.mockResolvedValue('INSERT INTO "APP"."MixedCopy" SELECT * FROM "APP"."SOURCE"');
  packageSaveAs.prepare.mockReset();
  packageSaveAs.execute.mockReset();
  packageSaveAs.dispose.mockReset().mockResolvedValue(undefined);
  packageSaveAs.prepareExecution.mockReset().mockImplementation(async (...args: unknown[]) => Object.assign(() => packageSaveAs.execute(...args), { dispose: packageSaveAs.dispose }));
  backend.executeQuery.mockImplementation(async (_id, _db, sql: string) => {
    if (sql.includes("ALL_TAB_COMMENTS")) return result([["source comment"]]);
    if (sql.includes("ALL_TABLES")) return result([["NO", "N"]]);
    return result();
  });
});

afterAll(() => expect([...auxiliaryRequests]).toEqual([]));

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  invalidateObjectBrowserRowsCache({});
});

async function mountEntry(surface: "sidebar" | "objects") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ ...connection }];
  store.connectedIds.add(connection.id);
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  store.treeNodes = [{ id: `${connection.id}:APP:APP`, type: "schema", label: "APP", connectionId: connection.id, database: "APP", schema: "APP", children: [], isExpanded: false }];
  const refresh = vi.spyOn(store, "refreshObjectListTreeNode");
  const component = ref<any>(null);
  const context = ref({ connection, database: "APP", schema: "APP" });
  let controller: any;
  const app = createApp({
    setup: () => () =>
      surface === "sidebar"
        ? h(SidebarTreeRuntimeHost, {
            ref: component,
            node: source,
            depth: 0,
            onOpenDialogController: (value: unknown) => {
              controller = value;
            },
          })
        : h(ObjectBrowser, { ref: component, ...context.value }),
  });
  app.use(pinia);
  app.use(i18n);
  const container = document.createElement("div");
  document.body.append(container);
  mounted.push(app);
  app.mount(container);
  await nextTick();
  if (surface === "sidebar") component.value.buildContextMenu(source);
  else controller = component.value.$.setupState;
  await nextTick();
  expect(controller).toBeDefined();
  controller.duplicateTableName = '"MixedCopy"';
  if (surface === "objects") controller.duplicateTarget = { name: "SOURCE", schema: "APP", object_type: "TABLE" };
  controller.pasteTableEntries = [{ sourceName: "SOURCE", targetName: '"MixedCopy"', connectionId: connection.id, database: "APP", schema: "APP" }];
  controller.pasteTableMode = "structure-and-data";
  return { controller, refresh, context, app, runtime: component.value.$.setupState };
}

async function acceptClone() {
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  const button = Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).find((item) => item.textContent?.trim() === i18n.global.t("dangerDialog.confirm"));
  expect(button).toBeDefined();
  button!.click();
  await nextTick();
}

describe.each(["sidebar", "objects"] as const)("%s OceanBase clone entry points", (surface) => {
  it("keeps the captured Spanner identifier quote while data-copy metadata is pending", async () => {
    const { controller, context } = await mountEntry(surface);
    const store = useConnectionStore();
    const spanner = { ...connection, db_type: "spanner", driver_profile: "spanner", password: "fixture-only" } as ConnectionConfig;
    store.connections = [spanner];
    context.value = { connection: spanner, database: "APP", schema: "APP" };
    await nextTick();
    controller.pasteTableMode = "data-only";
    vi.spyOn(api, "connectDb").mockResolvedValue(connection.id);
    vi.spyOn(api, "connectionDatabaseInfo").mockResolvedValue(null);
    const quote = vi.spyOn(api, "connectionIdentifierQuote").mockResolvedValue('"');
    await store.connect(spanner);
    expect(store.connectionIdentifierQuote(connection.id)).toBe('"');
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.getColumns).mockImplementationOnce(async () => {
      await paused;
      return [{ name: "ID", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null }];
    });
    const pending = controller.confirmPasteTable();
    await vi.waitFor(() => expect(api.getColumns).toHaveBeenCalled());
    quote.mockResolvedValue("`");
    await store.connect(spanner);
    expect(store.connectionIdentifierQuote(connection.id)).toBe("`");
    release();
    await pending;
    expect(backend.buildCopyTableDataSql).toHaveBeenCalledWith(expect.objectContaining({ identifierQuote: '"' }));
  });

  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("does not replace the pending confirmation when a repeated %s would fail planning", async (action) => {
    const { controller } = await mountEntry(surface);
    const pending = controller[action]();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Confirm table copy"));
    backend.buildCreateTableSql.mockRejectedValue(new Error("second planning failed"));
    await controller[action]();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Confirm table copy");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("second planning failed");
    await acceptClone();
    await pending;
    expect(ddlCalls().filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
  });

  it("retains committed structure and unexecuted data when the data SQL builder fails", async () => {
    const { controller } = await mountEntry(surface);
    backend.buildCopyTableDataSql.mockRejectedValueOnce(new Error("data builder unavailable"));
    const pending = controller.confirmPasteTable();
    await acceptClone();
    await pending;
    const dialog = document.querySelector('[role="dialog"]')?.textContent;
    expect(dialog).toContain("data builder unavailable");
    expect(dialog).toContain('Completed and committed: Table "APP"."MixedCopy"');
    expect(dialog).toContain('Not executed: Data "APP"."MixedCopy"');
    expect(ddlCalls().some((call) => String(call[2]).startsWith("INSERT"))).toBe(false);
  });

  it("localizes clone validation errors without losing quoted object names", async () => {
    await loadLocaleMessages("zh-CN");
    i18n.global.locale.value = "zh-CN";
    const { controller } = await mountEntry(surface);
    const read = backend.executeQuery.getMockImplementation()!;
    backend.executeQuery.mockImplementation(async (...args) => (String(args[2]).includes("VIRTUAL_COLUMN") ? result([['Computed"Value']]) : read(...args)));
    await controller.confirmPasteTable();
    const dialog = document.querySelector('[role="dialog"]')?.textContent;
    expect(dialog).toContain('不支持克隆虚拟列："Computed""Value"。未执行 DDL。');
    expect(dialog).not.toContain("virtualColumns");
    expect(ddlCalls()).toEqual([]);
  });

  it("renders the scope and failure ledger in the selected Chinese locale", async () => {
    await loadLocaleMessages("zh-CN");
    i18n.global.locale.value = "zh-CN";
    const { controller } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    const read = backend.executeQuery.getMockImplementation()!;
    backend.executeQuery.mockImplementation(async (...args) => (String(args[2]).startsWith("COMMENT ") ? { ...result(), execution_error: true, error: { detail: "ORA-01031" } } : read(...args)));
    const pending = controller.confirmPasteTable();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("确认复制表"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("不复制");
    await acceptClone();
    await pending;
    const dialog = document.querySelector('[role="dialog"]')?.textContent;
    expect(dialog).toContain("复制表已停止");
    expect(dialog).toContain("已完成并提交");
    expect(dialog).toContain("数据库已拒绝");
    expect(dialog).not.toContain("oceanbaseCloneDialog.");
  });

  it("confirms the whole batch once with collapsed SQL before any writes", async () => {
    const { controller } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    controller.pasteTableEntries.push({ ...controller.pasteTableEntries[0], targetName: '"OtherCopy"' });
    const pending = controller.confirmPasteTable();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("OtherCopy"));
    expect(ddlCalls()).toEqual([]);
    const details = document.querySelector<HTMLDetailsElement>("details[data-testid='danger-code-container']");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    await acceptClone();
    await pending;
    expect(ddlCalls().filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(2);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("keeps the original confirmation when the same action is requested again", async () => {
    const { controller } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    const pending = controller.confirmPasteTable();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    await controller.confirmPasteTable();
    expect(ddlCalls()).toEqual([]);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await acceptClone();
    await pending;
    expect(ddlCalls().filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
  });

  it("does not execute an earlier planned target if a later target cannot be planned", async () => {
    const { controller } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    controller.pasteTableEntries.push({ ...controller.pasteTableEntries[0], targetName: '"OtherCopy"' });
    backend.buildCreateTableSql.mockImplementationOnce(async ({ schema, tableName }) => ({ statements: [`CREATE TABLE "${schema}"."${tableName}" ("ID" NUMBER);`], warnings: [] })).mockRejectedValueOnce(new Error("metadata unavailable"));
    await controller.confirmPasteTable();
    expect(ddlCalls()).toEqual([]);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("metadata unavailable");
  });

  it("rejects duplicate resolved batch targets without any writes", async () => {
    const { controller } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    controller.pasteTableEntries.push({ ...controller.pasteTableEntries[0] });
    await controller.confirmPasteTable();
    expect(ddlCalls()).toEqual([]);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Multiple copies target");
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("keeps per-target production protection after the single batch scope confirmation", async () => {
    connection.is_production = true;
    const { controller } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    controller.pasteTableEntries.push({ ...controller.pasteTableEntries[0], targetName: '"OtherCopy"' });
    const pending = controller.confirmPasteTable();
    await acceptClone();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending?.sql).toContain('CREATE TABLE "APP"."MixedCopy"'));
    expect(ddlCalls()).toEqual([]);
    safety.confirm();
    await vi.waitFor(() => expect(safety.pending?.sql).toContain('CREATE TABLE "APP"."OtherCopy"'));
    expect(ddlCalls().filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
    safety.cancel();
    await pending;
    expect(ddlCalls().some((call) => String(call[2]).includes("OtherCopy"))).toBe(false);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("keeps the database failure and ledger when the subsequent refresh also fails", async () => {
    const { controller, refresh } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    refresh.mockRejectedValue(new Error("refresh unavailable"));
    const read = backend.executeQuery.getMockImplementation()!;
    backend.executeQuery.mockImplementation(async (...args) => (String(args[2]).startsWith("COMMENT ") ? { ...result(), execution_error: true, error: { detail: "ORA-01031" } } : read(...args)));
    const pending = controller.confirmPasteTable();
    await acceptClone();
    await pending;
    const dialog = document.querySelector('[role="dialog"]')?.textContent;
    expect(dialog).toContain("ORA-01031");
    expect(dialog).toContain("Completed and committed");
    expect(dialog).toContain("Refresh also failed");
    expect(dialog).toContain("refresh unavailable");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("rejects index-name collisions between distinct batch targets before writing", async () => {
    const { controller } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    controller.pasteTableEntries[0].targetName = `${"A".repeat(25)}ONE`;
    controller.pasteTableEntries.push({ ...controller.pasteTableEntries[0], targetName: `${"A".repeat(25)}TWO` });
    vi.spyOn(api, "listIndexes").mockResolvedValue([{ name: "IX_SOURCE", columns: ["ID"], is_unique: false, is_primary: false, index_type: "NORMAL" }]);
    const read = backend.executeQuery.getMockImplementation()!;
    backend.executeQuery.mockImplementation(async (...args) => {
      const sql = String(args[2]);
      if (sql.includes("ALL_IND_COLUMNS")) return result([["IX_SOURCE", "ID", 1, "ASC"]]);
      if (sql.includes("ALL_INDEXES")) return result([["IX_SOURCE", "VISIBLE"]]);
      return read(...args);
    });
    await controller.confirmPasteTable();
    expect(ddlCalls()).toEqual([]);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("same index");
  });

  it("stops the batch on its first failure and lists the remaining target once", async () => {
    const { controller } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    controller.pasteTableEntries.push({ ...controller.pasteTableEntries[0], targetName: '"OtherCopy"' });
    const read = backend.executeQuery.getMockImplementation()!;
    backend.executeQuery.mockImplementation(async (...args) => (String(args[2]).startsWith("COMMENT ") ? { ...result(), execution_error: true, error: { detail: "ORA-01031" } } : read(...args)));
    const pending = controller.confirmPasteTable();
    await acceptClone();
    await pending;
    expect(ddlCalls()).toHaveLength(2);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("OtherCopy");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Not executed");
    expect(window.alert).not.toHaveBeenCalled();
  });

  it.each(["rejected", "unknown"])("retains committed structure when data copy is %s", async (outcome) => {
    const { controller } = await mountEntry(surface);
    const read = backend.executeQuery.getMockImplementation()!;
    backend.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).startsWith("INSERT INTO")) {
        if (outcome === "unknown") throw new Error("connection lost");
        return { ...result(), execution_error: true, error: { detail: "ORA-01031" } };
      }
      return read(...args);
    });
    const pending = controller.confirmPasteTable();
    await acceptClone();
    await pending;
    const details = document.querySelector("details[data-testid='danger-code-container']")?.textContent;
    expect(details).toContain('Completed and committed: Table "APP"."MixedCopy"');
    expect(details).toContain(outcome === "rejected" ? "Rejected by the database: Data" : "Result unknown; the statement may have reached the server: Data");
    expect(details).toContain('INSERT INTO "APP"."MixedCopy"');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("reports completed targets before a later batch failure and leaves later targets unexecuted", async () => {
    const { controller } = await mountEntry(surface);
    controller.pasteTableMode = "structure-only";
    controller.pasteTableEntries.push({ ...controller.pasteTableEntries[0], targetName: '"OtherCopy"' }, { ...controller.pasteTableEntries[0], targetName: '"LastCopy"' });
    const read = backend.executeQuery.getMockImplementation()!;
    backend.executeQuery.mockImplementation(async (...args) => (String(args[2]).startsWith('CREATE TABLE "APP"."OtherCopy"') ? { ...result(), execution_error: true, error: { detail: "ORA-01031" } } : read(...args)));
    const pending = controller.confirmPasteTable();
    await acceptClone();
    await pending;
    const details = document.querySelector("details[data-testid='danger-code-container']")?.textContent;
    expect(details).toContain("Completed and committed:APP.MixedCopy");
    expect(details).toContain("Rejected by the database");
    expect(details).toContain("Not executed:APP.LastCopy");
    expect(ddlCalls().some((call) => String(call[2]).includes("LastCopy"))).toBe(false);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("uses the existing application dialog and cancels %s without browser prompts", async (action) => {
    const { controller } = await mountEntry(surface);
    const pending = controller[action]();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    expect(window.confirm).not.toHaveBeenCalled();
    expect(ddlCalls()).toEqual([]);
    const dialog = document.querySelector('[role="dialog"]')!;
    const cancel = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent?.trim() === i18n.global.t("dangerDialog.cancel"));
    expect(cancel).toBeDefined();
    cancel!.click();
    await pending;
    expect(ddlCalls()).toEqual([]);
    expect(backend.buildCopyTableDataSql).not.toHaveBeenCalled();
  });

  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("honors production confirmation cancellation in %s", async (action) => {
    connection.is_production = true;
    const { controller, refresh } = await mountEntry(surface);
    const pending = controller[action]();
    await acceptClone();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending?.sql).toContain("CREATE TABLE"));
    safety.cancel();
    await pending;
    expect(ddlCalls()).toEqual([]);
    expect(backend.buildCopyTableDataSql).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("cancels pending %s on unmount before any DDL or data copy", async (action) => {
    const { controller, app } = await mountEntry(surface);
    const pending = controller[action]();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    mounted.splice(mounted.indexOf(app), 1);
    app.unmount();
    await pending;
    expect(window.confirm).not.toHaveBeenCalled();
    expect(ddlCalls()).toEqual([]);
    expect(backend.buildCopyTableDataSql).not.toHaveBeenCalled();
  });

  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("refreshes after partial failure in %s and stops later writes", async (action) => {
    const { controller, refresh } = await mountEntry(surface);
    const read = backend.executeQuery.getMockImplementation()!;
    backend.executeQuery.mockImplementation(async (...args) => (String(args[2]).startsWith("COMMENT ") ? { ...result(), execution_error: true, error: { detail: "ORA-01031: insufficient privileges" } } : read(...args)));
    const pending = controller[action]();
    await acceptClone();
    await pending;
    expect(ddlCalls()).toHaveLength(2);
    expect(window.alert).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(i18n.global.t("oceanbaseCloneDialog.rejected"));
    expect(refresh).toHaveBeenCalledWith(connection.id, "APP", "APP");
    expect(backend.buildCopyTableDataSql).not.toHaveBeenCalled();
  });

  it("uses the resolved exact name for data copy after structure creation", async () => {
    const { controller } = await mountEntry(surface);
    const pending = controller.confirmPasteTable();
    await acceptClone();
    await pending;
    expect(backend.buildCopyTableDataSql).toHaveBeenCalledWith(expect.objectContaining({ targetName: "MixedCopy", schema: "APP", normalizeNewTargetName: false }));
    expect(ddlCalls().map((call) => call[2])).toEqual(['CREATE TABLE "APP"."MixedCopy" ("ID" NUMBER)', 'COMMENT ON TABLE "APP"."MixedCopy" IS \'source comment\'', 'INSERT INTO "APP"."MixedCopy" SELECT * FROM "APP"."SOURCE"']);
  });
});

describe.each([false, true])("ObjectBrowser clone execution identity (comment rejected: %s)", (rejected) => {
  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("keeps writes on the original connection during %s", async (action) => {
    const { controller, context, refresh } = await mountEntry("objects");
    const read = backend.executeQuery.getMockImplementation()!;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).startsWith("CREATE TABLE")) await paused;
      if (rejected && String(args[2]).startsWith("COMMENT ")) return { ...result(), execution_error: true, error: { detail: "ORA-01031: insufficient privileges" } };
      return read(...args);
    });
    const pending = controller[action]();
    await acceptClone();
    await vi.waitFor(() => expect(ddlCalls()).toHaveLength(1));
    const otherConnection = { ...connection, id: "different-connection" };
    const store = useConnectionStore();
    store.connections.push(otherConnection);
    store.connectedIds.add(otherConnection.id);
    context.value = { connection: otherConnection, database: "OTHER", schema: "OTHER" };
    await nextTick();
    release();
    await pending;
    expect(ddlCalls().map((call) => call.slice(0, 2))).toEqual(ddlCalls().map(() => [connection.id, "APP"]));
    expect(refresh).toHaveBeenCalledWith(connection.id, "APP", "APP");
    expect(refresh.mock.calls.every((call) => call[0] === connection.id)).toBe(true);
    if (rejected) expect(backend.buildCopyTableDataSql).not.toHaveBeenCalled();
  });
});

describe("ObjectBrowser clone confirmation identity", () => {
  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("checks the original production connection after planning in %s", async (action) => {
    connection.is_production = true;
    const { controller, context } = await mountEntry("objects");
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.buildCreateTableSql.mockImplementationOnce(async () => {
      await paused;
      return { statements: ['CREATE TABLE "APP"."MixedCopy" ("ID" NUMBER);'], warnings: [] };
    });
    const pending = controller[action]();
    await vi.waitFor(() => expect(backend.buildCreateTableSql).toHaveBeenCalled());
    const otherConnection = { ...connection, id: "different-connection", is_production: false };
    const store = useConnectionStore();
    store.connections.push(otherConnection);
    store.connectedIds.add(otherConnection.id);
    context.value = { connection: otherConnection, database: "OTHER", schema: "OTHER" };
    await nextTick();
    release();
    await acceptClone();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending?.database).toBe("APP"));
    safety.cancel();
    await pending;
    expect(ddlCalls()).toEqual([]);
  });
});

async function beginPackageSaveAs(surface: "sidebar" | "objects") {
  const { controller, refresh, context, runtime } = await mountEntry(surface);
  const packageTarget = surface === "sidebar" ? ({ id: `${connection.id}:APP:APP:package:P_OLD`, type: "package", label: "P_OLD", objectName: "P_OLD", connectionId: connection.id, database: "APP", schema: "APP" } as TreeNode) : { name: "P_OLD", type: "PACKAGE", schema: "APP" };
  const plan = {
    target: { connectionId: connection.id, database: "APP", databaseType: "oceanbase-oracle", schema: "APP", oldName: "P_OLD", newName: "P_NEW" },
    canonicalNewName: "P_NEW",
    snapshot: null,
    specDraft: "PACKAGE P_OLD AS END P_OLD;",
    bodyDraft: null,
    specSource: 'CREATE PACKAGE "P_NEW" AS END "P_NEW";',
    bodySource: null,
    statements: ["CREATE PACKAGE"],
    issues: [],
    metadataComplete: true,
    executable: true,
  } as OraclePackageSaveAsPlan;
  packageSaveAs.prepare.mockResolvedValue(plan);
  if (surface === "sidebar") {
    const action = runtime.buildContextMenu(packageTarget).find((item: { label: string }) => item.label === i18n.global.t("objects.packageSaveAsTitle")) as { action?: () => void } | undefined;
    expect(action?.action).toBeDefined();
    action!.action!();
  } else controller.requestPackageSaveAs(packageTarget);
  controller.packageSaveAsName = "P_NEW";
  await vi.waitFor(() => expect(controller.packageSaveAsPlan).toBeDefined());
  return { controller, refresh, context, plan };
}

describe.each(["sidebar", "objects"] as const)("%s Oracle package Save As failure refresh", (surface) => {
  it("binds the execution before production confirmation and releases the unused approval on cancel", async () => {
    connection.is_production = true;
    const { controller, plan } = await beginPackageSaveAs(surface);
    const pending = controller.confirmPackageSaveAs();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toMatchObject({ sql: plan.statements.join("\n\n") }));
    expect(packageSaveAs.prepareExecution).toHaveBeenCalledExactlyOnceWith(plan, expect.any(Function));
    expect(packageSaveAs.execute).not.toHaveBeenCalled();
    safety.cancel();
    await pending;
    expect(packageSaveAs.execute).not.toHaveBeenCalled();
    expect(packageSaveAs.dispose).toHaveBeenCalledOnce();
    expect(controller.packageSaveAsOpen).toBe(true);
  });

  it("refreshes the target tree and keeps the failed plan editable for recovery", async () => {
    const { controller, refresh, plan } = await beginPackageSaveAs(surface);
    packageSaveAs.execute.mockRejectedValue(new OraclePackageSaveAsFailure(plan, ["PACKAGE P_NEW"], "PACKAGE BODY P_NEW", new Error("body failed"), true));

    await controller.confirmPackageSaveAs();

    expect(refresh).toHaveBeenCalledWith(connection.id, "APP", "APP");
    expect(controller.packageSaveAsOpen).toBe(true);
    expect(controller.packageSaveAsError).not.toBe("");
    expect(controller.packageSaveAsPlan).toMatchObject({ executable: false });
  });

  it("keeps the DDL failure and disabled plan when the metadata refresh also fails", async () => {
    const { controller, refresh, plan } = await beginPackageSaveAs(surface);
    const drafts = { ...controller.packageSaveAsDrafts };
    refresh.mockRejectedValue(new Error("refresh unavailable"));
    packageSaveAs.execute.mockRejectedValue(new OraclePackageSaveAsFailure(plan, ["PACKAGE P_NEW"], "PACKAGE BODY P_NEW", new Error("body failed"), true));

    await controller.confirmPackageSaveAs();

    expect(refresh).toHaveBeenCalledWith(connection.id, "APP", "APP");
    expect(controller.packageSaveAsDiagnostic).toContain("body failed");
    expect(controller.packageSaveAsPlan).toMatchObject({ executable: false });
    expect(controller.packageSaveAsDrafts).toEqual(drafts);
  });

  it("does not apply a late failure to a different target or draft", async () => {
    const { controller, refresh, context, plan } = await beginPackageSaveAs(surface);
    let rejectExecution!: (error: unknown) => void;
    packageSaveAs.execute.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectExecution = reject;
      }),
    );
    const pending = controller.confirmPackageSaveAs();
    await vi.waitFor(() => expect(packageSaveAs.execute).toHaveBeenCalled());

    if (surface === "sidebar") {
      controller.packageSaveAsTarget = { id: "other:APP:APP:package:P_OTHER", type: "package", label: "P_OTHER", objectName: "P_OTHER", connectionId: "other", database: "APP", schema: "APP" };
    } else {
      context.value = { connection: { ...connection, id: "other" }, database: "OTHER", schema: "OTHER" };
    }
    await nextTick();
    controller.packageSaveAsDrafts = { body: "P_OTHER draft" };
    rejectExecution(new OraclePackageSaveAsFailure(plan, ["PACKAGE P_NEW"], "PACKAGE BODY P_NEW", new Error("body failed"), true));
    await pending;

    expect(refresh).toHaveBeenCalledWith(connection.id, "APP", "APP");
    expect(controller.packageSaveAsDrafts).toEqual({ body: "P_OTHER draft" });
    expect(controller.packageSaveAsError).toBe("");
  });

  it("preserves a same-scope replacement draft when the previous target fails late", async () => {
    const { controller, refresh, plan } = await beginPackageSaveAs(surface);
    let rejectExecution!: (error: unknown) => void;
    packageSaveAs.execute.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectExecution = reject;
      }),
    );
    const pending = controller.confirmPackageSaveAs();
    await vi.waitFor(() => expect(packageSaveAs.execute).toHaveBeenCalled());

    controller.packageSaveAsTarget = surface === "sidebar" ? { id: `${connection.id}:APP:APP:package:P_OTHER`, type: "package", label: "P_OTHER", objectName: "P_OTHER", connectionId: connection.id, database: "APP", schema: "APP" } : { name: "P_OTHER", type: "PACKAGE", schema: "APP" };
    await nextTick();
    controller.packageSaveAsDrafts = { body: "P_OTHER draft" };
    rejectExecution(new OraclePackageSaveAsFailure(plan, ["PACKAGE P_NEW"], "PACKAGE BODY P_NEW", new Error("body failed"), true));
    await pending;

    expect(refresh).toHaveBeenCalledWith(connection.id, "APP", "APP");
    expect(controller.packageSaveAsDrafts).toEqual({ body: "P_OTHER draft" });
    expect(controller.packageSaveAsError).toBe("");
  });
});

describe.each(["sidebar", "objects"] as const)("%s MySQL copy task entry point", (surface) => {
  it("uses the owned copy task for clone and paste, blocks reentry, and refreshes the target data tab", async () => {
    const { controller, context } = await mountEntry(surface);
    const mysql = { ...connection, db_type: "mysql", driver_profile: "mysql" } as ConnectionConfig;
    useConnectionStore().connections = [mysql];
    context.value = { connection: mysql, database: "APP", schema: "APP" };
    controller.pasteTableEntries = [{ sourceName: "SOURCE", targetName: "mysql_copy", connectionId: connection.id, database: "APP", schema: "APP" }];
    backend.buildDuplicateTableStructureSql.mockResolvedValue("CREATE TABLE `mysql_copy` LIKE `SOURCE`;");
    backend.buildCopyTableDataSql.mockResolvedValue("INSERT INTO `mysql_copy` (`ID`) SELECT `ID` FROM `SOURCE`;");
    let finish!: () => void;
    const copying = new Promise<void>((resolve) => {
      finish = resolve;
    });
    backend.executeConditionalUpdate.mockImplementation(async (_id, _db, sql: string) => {
      if (sql.startsWith("INSERT")) await copying;
      return { ...result(), affected_rows: sql.startsWith("INSERT") ? 7000001 : 0 };
    });
    const refreshData = vi.spyOn(useQueryStore(), "refreshDataTabsForTable").mockResolvedValue(1);
    await nextTick();
    const pending = controller.confirmPasteTable();
    await vi.waitFor(() => expect(backend.executeConditionalUpdate).toHaveBeenCalledTimes(2));
    const task = useTableCopyTaskStore();
    expect(task.open).toBe(false);
    expect(task.task?.phase).toBe("data");
    expect(controller.showPasteDialog).toBe(false);
    expect(refreshData).not.toHaveBeenCalled();
    await controller.confirmPasteTable();
    expect(backend.executeConditionalUpdate).toHaveBeenCalledTimes(2);
    finish();
    await pending;
    expect(task.task?.status).toBe("succeeded");
    expect(task.task?.targets[0]?.copiedRows).toBe(7000001);
    expect(refreshData).toHaveBeenCalledWith(expect.objectContaining({ connectionId: connection.id, database: "APP", name: "mysql_copy" }));
  });
});
