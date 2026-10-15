// @vitest-environment happy-dom
import { createApp, h, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TableStructureEditor from "../TableStructureEditor.vue";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listPlugins: vi.fn().mockResolvedValue([]),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  listDataTypes: vi.fn().mockResolvedValue([]),
  getColumns: vi.fn(async (_id, _database, _schema, table) => (table === "SOURCE" ? ["A", "B"] : ["ID", "V"]).map((name) => ({ name, data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null }))),
  listConstraints: vi.fn().mockResolvedValue([]),
  listIndexes: vi.fn().mockResolvedValue([]),
  listForeignKeys: vi.fn().mockResolvedValue([
    { name: "FK_SOURCE", column: "A", ref_schema: "PARENT_OWNER", ref_table: "PARENT", ref_column: "ID", on_delete: "CASCADE", on_update: null },
    { name: "FK_SOURCE", column: "B", ref_schema: "PARENT_OWNER", ref_table: "PARENT", ref_column: "V", on_delete: "CASCADE", on_update: null },
  ]),
  listTriggers: vi.fn().mockResolvedValue([]),
  getTableComment: vi.fn().mockResolvedValue(""),
  getTablePartitioning: vi.fn().mockResolvedValue(null),
  buildTableStructureChangeSql: vi.fn().mockResolvedValue({ statements: [], warnings: [] }),
  buildCreateTableSql: vi.fn().mockResolvedValue({ statements: [], warnings: [] }),
  saveHistory: vi.fn().mockResolvedValue(undefined),
  disconnectDb: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn(async (_id, _database, sql: string) => ({
    columns: [],
    rows: sql.includes("SELECT USER")
      ? [["APP"]]
      : sql.includes("SYS.ALL_TABLES")
        ? [["APP", "SOURCE"]]
        : sql.includes("SYS.ALL_CONSTRAINTS") || sql.includes("SYS.USER_CONSTRAINTS")
          ? [["FK_SOURCE", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "PARENT_OWNER", "PK_PARENT", "CASCADE"]]
          : [['ALTER TABLE "APP"."SOURCE" ADD CONSTRAINT "FK_SOURCE" FOREIGN KEY ("A", "B") REFERENCES "PARENT_OWNER"."PARENT" ("ID", "V") ON DELETE CASCADE ENABLE VALIDATE']],
    execution_time_ms: 0,
    rows_affected: 0,
  })),
}));

let app: App | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  i18n.global.locale.value = "en";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected HTTP request");
    }),
  );
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Oracle family foreign key editing entry", () => {
  it.each([
    { databaseType: "oracle", readable: true },
    { databaseType: "oceanbase-oracle", readable: true },
    { databaseType: "oracle", readable: false },
    { databaseType: "oceanbase-oracle", readable: false },
  ])("activates $databaseType editing only after definition verification (readable=$readable)", async ({ databaseType, readable }) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    const id = `foreign-key-${databaseType}`;
    store.connections = [{ id, name: "Foreign key fixture", db_type: databaseType, driver_profile: databaseType, host: "fixture", port: 2881, username: "APP", database: "APP" } as ConnectionConfig];
    store.connectedIds.add(id);
    await invalidateObjectMetadataCache({ connectionId: id });
    const container = document.createElement("div");
    document.body.append(container);
    app = createApp({ render: () => h(TooltipProvider, {}, { default: () => h(TableStructureEditor, { connectionId: id, database: "APP", schema: "APP", tableName: "SOURCE", initialTab: "foreignKeys" }) }) });
    app.use(pinia);
    app.use(i18n);
    app.component("LightTooltip", LightTooltip);
    app.mount(container);
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('input[placeholder="' + i18n.global.t("structureEditor.foreignKeyName") + '"]')?.value).toBe("FK_SOURCE"));
    const name = container.querySelector<HTMLInputElement>('input[placeholder="' + i18n.global.t("structureEditor.foreignKeyName") + '"]')!;
    expect(container.textContent).toContain("PARENT_OWNER.PARENT");
    expect(name.disabled).toBe(true);
    const edit = container.querySelector<HTMLButtonElement>("[data-oracle-foreign-key-edit]");
    expect(edit).not.toBeNull();
    if (!readable) vi.mocked(api.executeQuery).mockRejectedValueOnce(new Error("Metadata access denied"));
    edit!.click();
    if (!readable) {
      await vi.waitFor(() => expect(edit!.disabled).toBe(false));
      expect(name.disabled).toBe(true);
      expect(container.querySelector("[data-oracle-foreign-key-state]")).toBeNull();
      expect(api.executeQuery).toHaveBeenCalledTimes(1);
      return;
    }
    await vi.waitFor(() => expect(name.disabled).toBe(false));
    expect(api.executeQuery).toHaveBeenCalledTimes(databaseType === "oracle" ? 3 : 4);
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
    const enabled = container.querySelector<HTMLInputElement>("[data-oracle-foreign-key-enabled]")!;
    const validated = container.querySelector<HTMLInputElement>("[data-oracle-foreign-key-validated]")!;
    const deferrable = container.querySelector<HTMLInputElement>("[data-oracle-foreign-key-deferrable]")!;
    expect(enabled.checked).toBe(true);
    expect(validated.checked).toBe(true);
    expect(deferrable.disabled).toBe(databaseType !== "oracle");
    enabled.checked = false;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(enabled.checked).toBe(false));
    if (databaseType === "oracle") {
      deferrable.checked = true;
      deferrable.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("[data-oracle-foreign-key-deferred]")!.disabled).toBe(false));
    }
    const referenceInputs = () => Array.from(container.querySelectorAll<HTMLInputElement>("[data-oracle-foreign-key-reference]"));
    expect(referenceInputs().map((input) => input.value)).toEqual(["ID", "V"]);
    container.querySelector<HTMLButtonElement>("[data-oracle-foreign-key-down]")!.click();
    await vi.waitFor(() => expect(referenceInputs().map((input) => input.value)).toEqual(["V", "ID"]));
    const rows = container.querySelectorAll("[data-oracle-foreign-key-pair]");
    expect(rows[0]!.textContent).toContain("B");
    expect(rows[1]!.textContent).toContain("A");
    const parentTable = container.querySelector<HTMLInputElement>('input[placeholder="' + i18n.global.t("structureEditor.referencedTable") + '"]')!;
    parentTable.value = "OtherParent";
    parentTable.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(referenceInputs().map((input) => input.value)).toEqual(["", ""]));
  });

  it("does not publish a created-table result into a reconnected session", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    const id = "foreign-key-create-generation";
    store.connections = [{ id, name: "Create fixture", db_type: "oracle", driver_profile: "oracle", host: "fixture", port: 1521, username: "APP", database: "APP" } as ConnectionConfig];
    store.connectedIds.add(id);
    const createSql = 'CREATE TABLE "APP"."NEW_TABLE" ("ID" NUMBER PRIMARY KEY)';
    const addSql = 'ALTER TABLE "APP"."NEW_TABLE" ADD CONSTRAINT "FK_SELF" FOREIGN KEY ("ID") REFERENCES "APP"."NEW_TABLE" ("ID") ENABLE VALIDATE';
    vi.mocked(api.buildCreateTableSql).mockResolvedValue({ statements: [`${createSql};`, `${addSql};`], warnings: [] } as never);
    const result = (rows: unknown[][] = []) => ({ columns: [], rows, execution_time_ms: 0, rows_affected: 0 });
    let finishAdd!: (value: ReturnType<typeof result>) => void;
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([["APP", "APP"]]) as never;
      if (sql.startsWith(createSql)) return result([]) as never;
      if (sql.startsWith(addSql))
        return new Promise((resolve) => {
          finishAdd = resolve as typeof finishAdd;
        }) as never;
      throw new Error(`Unexpected query during create: ${sql}`);
    });
    const container = document.createElement("div");
    document.body.append(container);
    const drafts: unknown[] = [];
    const saved: unknown[] = [];
    const editor = ref<{ applyChanges: () => Promise<boolean> }>();
    app = createApp({
      render: () =>
        h(
          TooltipProvider,
          {},
          {
            default: () =>
              h(TableStructureEditor, {
                connectionId: id,
                database: "APP",
                schema: "APP",
                tableName: "",
                initialTab: "foreignKeys",
                draft: {
                  dirty: true,
                  activeTab: "foreignKeys",
                  newTableName: "NEW_TABLE",
                  tableComment: "",
                  originalTableComment: "",
                  columns: [{ id: "new:id", name: "ID", dataType: "NUMBER", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: true, extra: {}, markedForDrop: false }],
                  indexes: [],
                  foreignKeys: [{ id: "new:fk", name: "FK_SELF", column: "ID", columns: ["ID"], refSchema: "APP", refTable: "NEW_TABLE", refColumn: "ID", refColumns: ["ID"], onUpdate: "", onDelete: "NO ACTION" }],
                  triggers: [],
                  initialized: true,
                },
                ref: editor,
                "onUpdate:draft": (draft: unknown) => drafts.push(draft),
                onSaved: (...args: unknown[]) => saved.push(args),
              }),
          },
        ),
    });
    app.use(pinia);
    app.use(i18n);
    app.component("LightTooltip", LightTooltip);
    app.mount(container);
    await vi.waitFor(() => expect(api.buildCreateTableSql).toHaveBeenCalled());
    const applyButton = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === i18n.global.t("structureEditor.apply"));
    await vi.waitFor(() => expect(applyButton()?.disabled).toBe(false));
    const draftUpdatesBeforeSave = drafts.length;

    const pendingSave = editor.value!.applyChanges();
    await vi.waitFor(() => expect(finishAdd).toBeTypeOf("function"));
    await store.disconnect(id, { skipTabHandling: true, markClosedByUser: false });
    finishAdd(result([]));
    await pendingSave;

    expect(saved).toEqual([]);
    expect(drafts).toHaveLength(draftUpdatesBeforeSave);
    expect(api.executeQuery.mock.calls.slice(-2).map((call) => String(call[2]).startsWith("CREATE TABLE") || String(call[2]).startsWith("ALTER TABLE"))).toEqual([true, true]);
  });

  it.each(["history", "refresh"] as const)("keeps an existing foreign-key result out of a disconnected generation while %s is pending", async (pendingAt) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    const id = "foreign-key-existing-generation";
    store.connections = [{ id, name: "Foreign key fixture", db_type: "oracle", driver_profile: "oracle", host: "fixture", port: 1521, username: "APP", database: "APP" } as ConnectionConfig];
    store.connectedIds.add(id);
    vi.mocked(api.buildTableStructureChangeSql).mockImplementation(
      async (options) =>
        ({
          statements: options.oracleForeignKeyChanges?.length ? ['ALTER TABLE "APP"."SOURCE" DISABLE CONSTRAINT "FK_SOURCE";'] : [],
          warnings: [],
        }) as never,
    );
    const result = (rows: unknown[][] = []) => ({ columns: [], rows, execution_time_ms: 0, rows_affected: 0, execution_error: false, truncated: false, has_more: false });
    let fkEnabled = "ENABLED";
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const refreshStartedPromise = new Promise<void>((resolve) => (refreshStarted = resolve));
    vi.mocked(api.listForeignKeys).mockImplementation(async () => {
      if (fkEnabled === "DISABLED" && pendingAt === "refresh") {
        refreshStarted();
        return new Promise(
          (resolve) =>
            (releaseRefresh = () =>
              resolve([
                { name: "FK_SOURCE", column: "A", ref_schema: "PARENT_OWNER", ref_table: "PARENT", ref_column: "ID", on_delete: "CASCADE", on_update: null },
                { name: "FK_SOURCE", column: "B", ref_schema: "PARENT_OWNER", ref_table: "PARENT", ref_column: "V", on_delete: "CASCADE", on_update: null },
              ] as never)),
        );
      }
      return [
        { name: "FK_SOURCE", column: "A", ref_schema: "PARENT_OWNER", ref_table: "PARENT", ref_column: "ID", on_delete: "CASCADE", on_update: null },
        { name: "FK_SOURCE", column: "B", ref_schema: "PARENT_OWNER", ref_table: "PARENT", ref_column: "V", on_delete: "CASCADE", on_update: null },
      ] as never;
    });
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.startsWith("ALTER TABLE")) {
        fkEnabled = "DISABLED";
        return result() as never;
      }
      if (sql.includes("SELECT USER, SYS_CONTEXT")) return result([["APP", "APP"]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([["APP", "SOURCE"]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result(sql.includes("PARENT_OWNER") ? [["PARENT_OWNER", "PARENT", 99]] : [["APP", "SOURCE", 77]]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result(
          sql.includes("PARENT_OWNER")
            ? [["ID", "NUMBER"]]
            : [
                ["A", "NUMBER", 22, null, null, "Y"],
                ["B", "NUMBER", 22, null, null, "Y"],
              ],
        ) as never;
      if (sql.includes("SYS.ALL_TAB_PRIVS")) return result([["REFERENCES"]]) as never;
      if (sql.includes("SYS.ALL_COL_PRIVS") || sql.includes("SESSION_PRIVS")) return result() as never;
      if (sql.includes("SYS.ALL_CONS_COLUMNS")) return result([["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "ID", 1]]) as never;
      if (sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")) return result([["FK_SOURCE", "SOURCE"]]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["FK_SOURCE", fkEnabled, "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "PARENT_OWNER", "PK_PARENT", "CASCADE"]]) as never;
      if (sql.includes("DBMS_METADATA.GET_DDL")) return result([[`ALTER TABLE "APP"."SOURCE" ADD CONSTRAINT "FK_SOURCE" FOREIGN KEY ("A", "B") REFERENCES "PARENT_OWNER"."PARENT" ("ID", "V") ON DELETE CASCADE ${fkEnabled === "ENABLED" ? "ENABLE" : "DISABLE"} VALIDATE`]]) as never;
      throw new Error(`Unexpected query during existing foreign-key update: ${sql}`);
    });
    let releaseHistory!: () => void;
    vi.mocked(api.saveHistory).mockImplementation(() => (pendingAt === "history" ? (new Promise<void>((resolve) => (releaseHistory = resolve)) as never) : (Promise.resolve() as never)));
    const container = document.createElement("div");
    document.body.append(container);
    const drafts: unknown[] = [];
    const saved: unknown[] = [];
    const editor = ref<{ applyChanges: () => Promise<boolean> }>();
    app = createApp({
      render: () =>
        h(
          TooltipProvider,
          {},
          {
            default: () =>
              h(TableStructureEditor, {
                connectionId: id,
                database: "APP",
                schema: "APP",
                tableName: "SOURCE",
                initialTab: "foreignKeys",
                ref: editor,
                "onUpdate:draft": (draft: unknown) => drafts.push(draft),
                onSaved: (...args: unknown[]) => saved.push(args),
              }),
          },
        ),
    });
    app.use(pinia);
    app.use(i18n);
    app.component("LightTooltip", LightTooltip);
    app.mount(container);
    const edit = () => container.querySelector<HTMLButtonElement>("[data-oracle-foreign-key-edit]");
    await vi.waitFor(() => expect(edit()).not.toBeNull());
    edit()!.click();
    const enabled = () => container.querySelector<HTMLInputElement>("[data-oracle-foreign-key-enabled]");
    await vi.waitFor(() => expect(enabled()?.disabled).toBe(false));
    enabled()!.checked = false;
    enabled()!.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.some(([options]) => options.oracleForeignKeyChanges?.length)).toBe(true));
    const draftUpdatesBeforeSave = drafts.length;

    const pendingSave = editor.value!.applyChanges();
    if (pendingAt === "history") await vi.waitFor(() => expect(api.saveHistory).toHaveBeenCalled());
    else await refreshStartedPromise;
    await store.disconnect(id, { skipTabHandling: true, markClosedByUser: false });
    if (pendingAt === "history") releaseHistory();
    else releaseRefresh();
    await pendingSave;

    expect(saved).toEqual([]);
    expect(drafts).toHaveLength(draftUpdatesBeforeSave);
    expect(api.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER TABLE"))).toBe(true);
  });
});
