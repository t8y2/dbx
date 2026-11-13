// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import TableStructureEditor from "../TableStructureEditor.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import i18n from "@/i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import type { ConnectionConfig, ObjectSource, TableStructureEditorDraft, TriggerInfo } from "@/types/database";
import type { BuildTableStructureChangeSqlOptions, TableStructureChangeSql } from "@/lib/table/tableStructureEditorSql";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import { invalidateObjectDdl } from "@/lib/metadata/objectDdlCache";
import { createColumnDrafts, createTriggerDrafts } from "@/lib/table/tableStructureEditorState";

const rpc = vi.hoisted(() => ({
  listPlugins: vi.fn(async () => []),
  listInstalledAgents: vi.fn(async () => []),
  checkConnectionHealth: vi.fn(async () => undefined),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => undefined),
  deleteSchemaCachePrefix: vi.fn(async () => undefined),
  listDataTypes: vi.fn(async () => ["NUMBER"]),
  getColumns: vi.fn(async () => [{ name: "ID", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null }]),
  listIndexes: vi.fn(async () => []),
  listForeignKeys: vi.fn(async () => []),
  listConstraints: vi.fn(async () => []),
  getTableComment: vi.fn(async () => ""),
  getTablePartitionStatus: vi.fn(async () => ({ isPartitionedParent: false, isPartition: false, isForeign: false })),
  getTablePartitioning: vi.fn(async () => null),
  buildTableStructureChangeSql: vi.fn(async (_options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> => ({ statements: [], warnings: [] })),
  listTriggers: vi.fn(),
  getObjectSource: vi.fn(),
  prepareOracleTriggerSql: vi.fn(),
  executeQuery: vi.fn(),
  executeBatch: vi.fn(),
  buildDropObjectSql: vi.fn(),
  saveHistory: vi.fn(async () => undefined),
  saveOpenTabsState: vi.fn(async () => undefined),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...rpc }));
const owner = "Trigger.Owner",
  parent = "Parent.Owner",
  name = "Complex Trigger";
const definition = `CREATE OR REPLACE TRIGGER "${owner}"."${name}" BEFORE INSERT ON "${parent}"."T" FOR EACH ROW WHEN (NEW.ID > 0) DISABLE BEGIN NULL; END;`;
let raw: ObjectSource;
let app: App | undefined;
const drafts: TableStructureEditorDraft[] = [];
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  await invalidateObjectMetadataCache({ connectionId: "trigger-structure-source" });
  await invalidateObjectDdl({ connectionId: "trigger-structure-source" });
  rpc.buildTableStructureChangeSql.mockReset().mockResolvedValue({ statements: [], warnings: [] });
  rpc.getColumns.mockReset().mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null }]);
  drafts.length = 0;
  i18n.global.locale.value = "en";
  const info: TriggerInfo = {
    name,
    timing: "BEFORE EACH ROW",
    event: "INSERT",
    statement: definition,
    condition: "NEW.ID > 0",
    enabled: false,
    valid: true,
    oracle_metadata: {
      contractVersion: 1,
      identityMode: "exact",
      engine: "oceanbase-oracle",
      engineVersion: "4.2.5.7_107",
      owner,
      name,
      objectId: "trigger-id",
      scope: "TABLE",
      parent: { owner: parent, name: "T", objectType: "TABLE" },
      definition: { origin: "DBMS_METADATA", format: "ddl", complete: true },
      errors: [],
      reads: { identity: { state: "available" }, scope: { state: "available" }, parent: { state: "available" }, enabled: { state: "available" }, validity: { state: "available" }, definition: { state: "available" }, errors: { state: "available" } },
    },
  };
  raw = { name, schema: owner, object_type: "TRIGGER", source: definition, trigger: info };
  rpc.listTriggers.mockImplementation(async () => [JSON.parse(JSON.stringify(raw.trigger))]);
  rpc.getObjectSource.mockImplementation(async () => JSON.parse(JSON.stringify(raw)));
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, structuredEditable: false, header: { scope: "RELATION", owner: parent, name: "T", viewOnly: false, pluggable: false }, requiresStateRestore: false }));
  rpc.executeQuery.mockImplementation(async (_id, _db, sql) => {
    if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "T", "TABLE", "parent-id"]] };
    raw.source = sql;
    raw.trigger!.statement = sql;
    return { columns: [], rows: [], affected_rows: 0 };
  });
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
}

async function mountStructure(draft?: TableStructureEditorDraft, catalog?: string, databaseType: "oracle" | "oceanbase-oracle" = "oceanbase-oracle") {
  let structure: InstanceType<typeof TableStructureEditor> | null = null;
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [{ id: "trigger-structure-source", name: "Trigger structure", db_type: databaseType, username: "Execution.Owner", database: "service" } as ConnectionConfig];
  connections.connectedIds.add("trigger-structure-source");
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(
        TooltipProvider,
        {},
        {
          default: () =>
            h(TableStructureEditor, {
              ref: (instance) => {
                structure = instance as InstanceType<typeof TableStructureEditor> | null;
              },
              connectionId: "trigger-structure-source",
              database: "service",
              catalog,
              schema: parent,
              tableName: "T",
              initialTab: "columns",
              draft,
              "onUpdate:draft": (draft?: TableStructureEditorDraft) => {
                if (draft) drafts.push(JSON.parse(JSON.stringify(draft)));
              },
            }),
        },
      ),
  });
  app.use(pinia);
  app.use(i18n);
  app.component("LightTooltip", LightTooltip);
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector("[data-column-name-input]")).not.toBeNull());
  return { host, structure: structure! };
}

it("distinguishes and selects same-name triggers from different owners in the actual structure panel", async () => {
  const second = structuredClone(raw);
  second.schema = "Other.Trigger.Owner";
  second.source = definition.replace(`"${owner}"`, '"Other.Trigger.Owner"');
  second.trigger!.statement = second.source;
  second.trigger!.oracle_metadata!.owner = second.schema;
  second.trigger!.oracle_metadata!.objectId = "other-trigger-id";
  rpc.listTriggers.mockResolvedValue([structuredClone(raw.trigger), second.trigger]);
  rpc.getObjectSource.mockImplementation(async (_id, _db, requestedOwner) => structuredClone(requestedOwner === second.schema ? second : raw));
  const { host } = await mountStructure();
  button(i18n.global.t("structureEditor.triggers"))!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  const names = () => [...host.querySelectorAll<HTMLElement>(`span[title="${name}"]`)];
  await vi.waitFor(() => expect(names()).toHaveLength(2));
  expect(names()[0].parentElement!.textContent).toContain(owner);
  expect(names()[1].parentElement!.textContent).toContain(second.schema);
  names()[1].parentElement!.click();
  await vi.waitFor(() => expect(rpc.getObjectSource.mock.calls.some((call) => call[2] === second.schema)).toBe(true));
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(second.source);
  expect(new Set(drafts.at(-1)!.triggers.map((trigger) => trigger.id)).size).toBe(2);
  expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(0);
});

it.each(["FOLLOWS OTHER_TRIGGER", "REFERENCING NEW AS N OLD AS O"])("keeps %s definitions out of the structured editor even when a provider supplies a plain body", async (clause) => {
  raw.trigger!.condition = null;
  raw.trigger!.statement = "BEGIN NULL; END;";
  raw.source = `CREATE OR REPLACE TRIGGER "${owner}"."${name}" BEFORE INSERT ON "${parent}"."T" ${clause} FOR EACH ROW DISABLE BEGIN NULL; END;`;
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, structuredEditable: false, header: { scope: "RELATION", owner: parent, name: "T", viewOnly: false, pluggable: false }, requiresStateRestore: false }));
  const { host } = await mountStructure();
  button(i18n.global.t("structureEditor.triggers"))!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await vi.waitFor(() => expect(drafts.at(-1)?.triggers[0]?.loadedOracleSource).toBe(raw.source));
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
  expect(button(i18n.global.t("oracleTrigger.editFullSource"))).toBeDefined();
  expect(button(i18n.global.t("damengJobAdmin.disabled"))!.disabled).toBe(false);
  expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toHaveLength(0);
});

it.each(["applied", "unknown", "cancelled", "closed"])("serializes an originally allowed column/trigger draft without opaque batch (%s)", async (outcome) => {
  const columnSql = 'ALTER TABLE "Parent.Owner"."T" RENAME COLUMN "ID" TO "ID_LOCAL_DRAFT"';
  const expectedColumnSql = 'ALTER TABLE "T" RENAME COLUMN "ID" TO "ID_LOCAL_DRAFT"';
  const toggleSql = 'ALTER TRIGGER "Trigger.Owner"."Complex Trigger" ENABLE;';
  const disableSql = 'ALTER TRIGGER "Trigger.Owner"."Complex Trigger" DISABLE;';
  let offline = false;
  let columnName = "ID";
  rpc.getColumns.mockImplementation(async () => [{ name: columnName, data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null }]);
  rpc.buildTableStructureChangeSql.mockImplementation(async (options) => {
    const statements = options.columns.some((column) => column.name !== column.original?.name) ? [columnSql] : [];
    const trigger = options.triggers?.[0];
    if (!trigger || trigger.enabled === trigger.original?.enabled) return { statements, warnings: [] };
    return { statements: [...statements, trigger.enabled ? toggleSql : disableSql], warnings: [], triggerOperations: [{ draftId: trigger.id, action: trigger.enabled ? "enable" : "disable", owner, name, statementIndex: statements.length, statementCount: 1, enabled: trigger.enabled }] };
  });
  rpc.getObjectSource.mockImplementation(async () => {
    if (offline) throw new Error("readback offline");
    return JSON.parse(JSON.stringify(raw));
  });
  rpc.executeQuery.mockImplementation(async (_id, _db, sql) => {
    if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "T", "TABLE", "parent-id"]] };
    if (sql.includes("RENAME COLUMN")) columnName = "ID_LOCAL_DRAFT";
    if (sql === toggleSql) {
      raw.trigger!.enabled = true;
      if (outcome === "unknown") {
        offline = true;
        throw new Error("reply lost");
      }
    }
    if (sql === disableSql) raw.trigger!.enabled = false;
    return { columns: [], rows: [], affected_rows: 0 };
  });
  const { host, structure } = await mountStructure(undefined, outcome === "unknown" ? "Recovery.Catalog" : undefined);
  const input = host.querySelector<HTMLInputElement>("[data-column-name-input]")!;
  input.value = "ID_LOCAL_DRAFT";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  button(i18n.global.t("structureEditor.triggers"))!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await vi.waitFor(() => expect(button(i18n.global.t("damengJobAdmin.disabled"))).toBeDefined());
  button(i18n.global.t("damengJobAdmin.disabled"))!.click();
  await vi.waitFor(() => expect(button(i18n.global.t("structureEditor.apply"))!.disabled).toBe(false));
  const applying = structure.applyChanges();
  if (outcome === "closed") {
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    app!.unmount();
    app = undefined;
  } else if (outcome === "cancelled") {
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.cancel();
  } else {
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    expect(danger.pending!.sql).toContain(toggleSql);
    danger.confirm();
  }
  expect(await applying).toBe(outcome === "applied");
  expect(rpc.executeBatch).not.toHaveBeenCalled();
  const writes = () => rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2]);
  expect(writes()).toEqual(outcome === "cancelled" || outcome === "closed" ? [] : [expectedColumnSql, toggleSql]);
  expect(rpc.buildTableStructureChangeSql.mock.calls.at(-1)![0].triggers![0].oracleExact).toEqual({ owner, parentType: "TABLE" });
  if (outcome === "unknown") {
    expect(drafts.at(-1)?.columns[0]?.name).toBe("ID_LOCAL_DRAFT");
    expect(drafts.at(-1)?.triggers[0]?.original?.enabled).toBe(false);
    await structure.applyChanges();
    expect(writes()).toEqual([expectedColumnSql, toggleSql]);
    offline = false;
    button(i18n.global.t("common.close"))!.click();
    button(i18n.global.t("oracleTrigger.reconcileStructure"))!.click();
    await vi.waitFor(() => expect(drafts.at(-1)?.oracleTriggerStructureRecovery).toBeUndefined());
    const identityRead = rpc.executeQuery.mock.calls.filter((call) => call[2].startsWith("SELECT") && call[5]?.maxRows === 2).at(-1)!;
    expect(identityRead[4]).toBeUndefined();
    expect(identityRead[5]).toEqual({ catalog: "Recovery.Catalog", maxRows: 2 });
    expect(drafts.at(-1)?.columns[0]?.original?.name).toBe("ID_LOCAL_DRAFT");
    expect(drafts.at(-1)?.triggers[0]?.original?.enabled).toBe(true);
    expect(writes()).toEqual([expectedColumnSql, toggleSql]);
    button(i18n.global.t("damengJobAdmin.enabled"))!.click();
    await vi.waitFor(() => expect(button(i18n.global.t("structureEditor.apply"))!.disabled).toBe(false));
    const remaining = structure.applyChanges();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    expect(danger.pending!.sql).toContain(disableSql);
    expect(danger.pending!.sql).not.toContain("RENAME COLUMN");
    danger.confirm();
    expect(await remaining).toBe(true);
    expect(writes()).toEqual([expectedColumnSql, toggleSql, disableSql]);
  }
});

it("still refuses an Oracle index/trigger mixed draft before either specialized or general writes", async () => {
  rpc.buildTableStructureChangeSql.mockImplementation(async (options) => ({
    statements: ['CREATE INDEX "IDX_T" ON "Parent.Owner"."T" ("ID")', 'ALTER TRIGGER "Trigger.Owner"."Complex Trigger" ENABLE;'],
    warnings: [],
    triggerOperations: [{ draftId: options.triggers![0].id, action: "enable", owner, name, statementIndex: 1, statementCount: 1, enabled: true }],
  }));
  const draft: TableStructureEditorDraft = {
    activeTab: "columns",
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: createColumnDrafts(await rpc.getColumns(), "oceanbase-oracle"),
    indexes: [{ id: "new:index", name: "IDX_T", columns: ["ID"], isUnique: false, isPrimary: false, filter: "", indexType: "NORMAL", includedColumns: [], comment: "", markedForDrop: false }],
    foreignKeys: [],
    triggers: createTriggerDrafts([raw.trigger!]).map((trigger) => ({ ...trigger, enabled: true })),
    constraints: [],
    constraintsLoaded: false,
    triggersLoaded: true,
    loadedMetadataFacets: ["columns", "indexes", "foreign-keys", "triggers"],
    initialized: true,
  };
  const { structure, host } = await mountStructure(draft);
  await vi.waitFor(() => expect(button(i18n.global.t("structureEditor.apply"))!.disabled).toBe(false));
  expect(await structure.applyChanges()).toBe(false);
  expect(host.textContent).toContain(i18n.global.t("oracleIndex.mixedDraft"));
  expect(rpc.executeBatch).not.toHaveBeenCalled();
  expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toEqual([]);
  expect(useSqlExecutionDangerStore().pending).toBeUndefined();
  expect(drafts.at(-1)?.indexes[0]?.name).toBe("IDX_T");
  expect(drafts.at(-1)?.triggers[0]?.enabled).toBe(true);
});

it.each(["primary-key", "constraint"])("does not route a mixed %s/trigger draft through the new general sequence", async (kind) => {
  const state = { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false };
  const originalCheck = { kind: "check" as const, definition: { name: "CK_T", expression: "ID > 0", state } };
  const draft: TableStructureEditorDraft = {
    activeTab: "columns",
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: createColumnDrafts(
      [
        { name: "ID", data_type: "NUMBER", is_nullable: false, is_primary_key: true, column_default: null },
        { name: "V", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null },
      ],
      "oceanbase-oracle",
    ),
    indexes: [],
    foreignKeys: [],
    constraints: [{ name: "PK_T", constraint_type: "PRIMARY KEY", columns: ["ID"], definition: "", ref_columns: [], enabled: true, valid: true, deferrable: false, initially_deferred: false }],
    constraintsLoaded: true,
    triggers: createTriggerDrafts([raw.trigger!]).map((trigger) => ({ ...trigger, enabled: true })),
    triggersLoaded: true,
    loadedMetadataFacets: ["columns", "constraints", "triggers"],
    initialized: true,
    ...(kind === "primary-key" ? { existingPrimaryKey: { name: "PK_T", originalColumns: ["ID"], columns: ["ID", "V"] } } : { oracleConstraintChange: { original: originalCheck, target: { kind: "check" as const, definition: { ...originalCheck.definition, expression: "ID > 1" } } } }),
  };
  const { structure, host } = await mountStructure(draft);
  await vi.waitFor(() => expect(host.textContent).toContain(kind === "primary-key" ? i18n.global.t("oceanbasePrimaryKey.mixedDraft") : "Apply CHECK/UNIQUE changes separately"));
  expect(await structure.applyChanges()).toBe(false);
  expect(rpc.executeBatch).not.toHaveBeenCalled();
  expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT"))).toEqual([]);
  expect(drafts.at(-1)?.triggers[0]?.enabled).toBe(true);
});

it("saves an ordinary structured body through the complete loaded baseline and exact replacement plan", async () => {
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, structuredEditable: true, header: { scope: "RELATION", owner: parent, name: "T", viewOnly: false, pluggable: false }, requiresStateRestore: false }));
  const body = "BEGIN :NEW.ID := 7; END;";
  const oldSource = `CREATE OR REPLACE TRIGGER "${owner}"."${name}" BEFORE INSERT ON "${parent}"."T" FOR EACH ROW DISABLE BEGIN NULL; END;`;
  const candidate = oldSource.replace("BEGIN NULL; END;", body);
  raw.source = oldSource;
  raw.trigger!.statement = "BEGIN NULL; END;";
  raw.trigger!.condition = undefined;
  rpc.buildTableStructureChangeSql.mockImplementation(async (options) => {
    const trigger = options.triggers?.[0];
    if (trigger?.statement !== body) return { statements: [], warnings: [] };
    return { statements: [candidate], warnings: [], triggerOperations: [{ draftId: trigger.id, action: "replace", owner, name, statementIndex: 0, statementCount: 1, enabled: false }] };
  });
  rpc.executeQuery.mockImplementation(async (_id, _db, sql) => {
    if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "T", "TABLE", "parent-id"]] };
    raw.source = sql;
    raw.trigger!.statement = body;
    return { columns: [], rows: [], affected_rows: 0 };
  });
  const { host, structure } = await mountStructure();
  button(i18n.global.t("structureEditor.triggers"))!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false));
  const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = body;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(button(i18n.global.t("structureEditor.apply"))!.disabled).toBe(false));
  const applying = structure.applyChanges(),
    danger = useSqlExecutionDangerStore();
  await vi.waitFor(() => expect(danger.pending).toBeDefined());
  expect(danger.pending!.sql).toBe(candidate);
  danger.confirm();
  expect(await applying).toBe(true);
  expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2])).toEqual([candidate]);
  expect(drafts.at(-1)?.triggers[0]?.original?.statement).toBe(body);
  expect(rpc.executeBatch).not.toHaveBeenCalled();
});

it.each(["NewTrigger", "new"])("retains the exact rename target %s after DROP succeeds but CREATE is rejected", async (newName) => {
  raw.trigger!.oracle_metadata!.engine = "oracle";
  rpc.prepareOracleTriggerSql.mockImplementation(async (input) => ({ definition: input.source, comparisonSource: input.source, structuredEditable: true, header: { scope: "RELATION", owner: parent, name: "T", viewOnly: false, pluggable: false }, requiresStateRestore: false }));
  const oldSource = `CREATE OR REPLACE TRIGGER "${owner}"."${name}" BEFORE INSERT ON "${parent}"."T" FOR EACH ROW DISABLE BEGIN NULL; END;`;
  raw.source = oldSource;
  raw.trigger!.statement = "BEGIN NULL; END;";
  raw.trigger!.condition = undefined;
  let oldExists = true;
  const neighbor = JSON.parse(JSON.stringify(raw.trigger)) as TriggerInfo;
  neighbor.name = "NEW";
  neighbor.enabled = true;
  Object.assign(neighbor.oracle_metadata!, { name: "NEW", objectId: "neighbor-id" });
  const neighbors = newName === "new" ? [neighbor] : [];
  const dropSql = `DROP TRIGGER "${owner}"."${name}";`;
  const newSql = (triggerOwner: string) => `CREATE TRIGGER "${triggerOwner}"."${newName}" BEFORE INSERT ON "${parent}"."T" FOR EACH ROW DISABLE BEGIN NULL; END;`;
  rpc.listTriggers.mockImplementation(async () => [...(oldExists ? [JSON.parse(JSON.stringify(raw.trigger))] : []), ...structuredClone(neighbors)]);
  rpc.buildDropObjectSql.mockResolvedValue(dropSql);
  rpc.getObjectSource.mockImplementation(async (_id, _db, requestedOwner, requestedName) => {
    if (requestedName === name && requestedOwner === owner && oldExists) return JSON.parse(JSON.stringify(raw));
    const absent: ObjectSource = JSON.parse(JSON.stringify(raw));
    absent.name = requestedName;
    absent.schema = requestedOwner;
    absent.source = "";
    absent.trigger!.name = requestedName;
    absent.trigger!.statement = "";
    Object.assign(absent.trigger!.oracle_metadata!, { name: requestedName, owner: requestedOwner, objectId: null, scope: "UNKNOWN", parent: null });
    absent.trigger!.oracle_metadata!.reads.identity = { state: "empty" };
    return absent;
  });
  rpc.buildTableStructureChangeSql.mockImplementation(async (options) => {
    const trigger = options.triggers?.[0];
    if (!trigger || trigger.name === trigger.original?.name) return { statements: [], warnings: [] };
    const actualOwner = trigger.oracleExact!.owner;
    const creating = { draftId: trigger.id, action: "create" as const, owner: actualOwner, name: newName, statementIndex: trigger.original ? 1 : 0, statementCount: 1, enabled: false };
    return { statements: [...(trigger.original ? [dropSql] : []), newSql(actualOwner)], warnings: [], triggerOperations: [...(trigger.original ? [{ ...creating, action: "delete" as const, name, statementIndex: 0 }] : []), creating] };
  });
  rpc.executeQuery.mockImplementation(async (_id, _db, sql) => {
    if (sql.startsWith("SELECT USER")) return { columns: ["SESSION_USER"], rows: [["Execution.Owner"]] };
    if (sql.includes("FROM DBA_OBJECTS")) return { columns: ["OWNER", "OBJECT_NAME"], rows: [] };
    if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "T", "TABLE", "parent-id"]] };
    if (sql === dropSql) {
      oldExists = false;
      return { columns: [], rows: [], affected_rows: 0 };
    }
    return {
      columns: [],
      rows: [],
      execution_error: true,
      error: {
        version: 1,
        code: "DBX-JDBC-4001",
        messageKey: "backendErrors.jdbc.sqlFailed",
        messageParams: {},
        source: "jdbc-agent",
        operationOutcome: "unknown",
        detail: "ORA-01031: insufficient privileges",
        origin: { subsystem: "database", adapter: "jdbc-agent" },
        diagnostics: { category: "sql", stage: "execute", vendorCode: 1031 },
      },
    } as never;
  });
  const { host, structure } = await mountStructure(undefined, undefined, "oracle");
  button(i18n.global.t("structureEditor.triggers"))!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false));
  host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t("structureEditor.triggerName")}"]`)!.click();
  await nextTick();
  const nameInput = host.querySelector<HTMLInputElement>(`input[placeholder="${i18n.global.t("structureEditor.triggerName")}"]`)!;
  nameInput.value = newName;
  nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(button(i18n.global.t("structureEditor.apply"))!.disabled).toBe(false));
  const applying = structure.applyChanges(),
    danger = useSqlExecutionDangerStore();
  await vi.waitFor(() => expect(danger.pending).toBeDefined());
  danger.confirm();
  expect(await applying).toBe(false);
  const writes = () => rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2]);
  expect(writes()).toEqual([dropSql, newSql(owner)]);
  expect(drafts.at(-1)?.triggers[0]?.loadedOracleSource).toBe(oldSource);
  expect(drafts.at(-1)?.oracleTriggerStructureRecovery?.steps.map((step) => step.state)).toEqual(["committed", "rejected"]);
  expect(await structure.applyChanges()).toBe(false);
  button(i18n.global.t("common.close"))!.click();
  button(i18n.global.t("oracleTrigger.reconcileStructure"))!.click();
  await vi.waitFor(() => expect(drafts.at(-1)?.oracleTriggerStructureRecovery).toBeUndefined());
  await vi.waitFor(() => expect(rpc.buildTableStructureChangeSql.mock.calls.at(-1)?.[0].triggers?.[0]?.original).toBeUndefined());
  expect(rpc.buildTableStructureChangeSql.mock.calls.at(-1)![0].triggers![0].oracleExact?.owner).toBe(owner);
  expect(rpc.buildTableStructureChangeSql.mock.calls.at(-1)![0].triggers![0].name.trim()).toBe(newName);
  if (neighbors.length) expect(drafts.at(-1)?.triggers.find((trigger) => trigger.name === "NEW")).toMatchObject({ enabled: true, original: { oracle_metadata: { objectId: "neighbor-id" } } });
  expect(writes()).toEqual([dropSql, newSql(owner)]);
});

it.each([false, true])("repairs a protected exact trigger without discarding a column draft (lost reply=%s)", async (lostReply) => {
  let offline = false;
  if (lostReply) {
    rpc.buildTableStructureChangeSql.mockResolvedValue({ statements: ['ALTER TABLE "Parent.Owner"."T" RENAME COLUMN "ID" TO "ID_LOCAL_DRAFT"'], warnings: [] });
    rpc.getObjectSource.mockImplementation(async () => {
      if (offline) throw new Error("readback offline");
      return JSON.parse(JSON.stringify(raw));
    });
    rpc.executeQuery.mockImplementation(async (_id, _db, sql) => {
      if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "T", "TABLE", "parent-id"]] };
      raw.source = sql;
      raw.trigger!.statement = sql;
      offline = true;
      throw new Error("reply lost");
    });
  }
  let structure: InstanceType<typeof TableStructureEditor> | null = null;
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [{ id: "trigger-structure-source", name: "Trigger structure", db_type: "oceanbase-oracle", username: "Execution.Owner", database: "service" } as ConnectionConfig];
  connections.connectedIds.add("trigger-structure-source");
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(
        TooltipProvider,
        {},
        {
          default: () =>
            h(TableStructureEditor, {
              ref: (instance) => {
                structure = instance as InstanceType<typeof TableStructureEditor> | null;
              },
              connectionId: "trigger-structure-source",
              database: "service",
              schema: parent,
              tableName: "T",
              initialTab: "columns",
              "onUpdate:draft": (draft?: TableStructureEditorDraft) => {
                if (draft) drafts.push(JSON.parse(JSON.stringify(draft)));
              },
            }),
        },
      ),
  });
  app.use(pinia);
  app.use(i18n);
  app.component("LightTooltip", LightTooltip);
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector("[data-column-name-input]")).not.toBeNull());
  const column = host.querySelector<HTMLInputElement>("[data-column-name-input]")!;
  column.value = "ID_LOCAL_DRAFT";
  column.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  button(i18n.global.t("structureEditor.triggers"))!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await vi.waitFor(() => expect(host.textContent).toContain(name));
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
  const edit = button(i18n.global.t("oracleTrigger.editFullSource"));
  expect(edit).toBeDefined();
  edit!.click();
  await vi.waitFor(() => expect(document.querySelector("[data-object-source-editor] .cm-editor")).not.toBeNull(), { timeout: 10_000 });
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>("[data-object-source-editor] .cm-editor")!)!;
  view.dispatch({ changes: { from: view.state.doc.toString().indexOf("NULL;"), to: view.state.doc.toString().indexOf("NULL;") + 5, insert: "NULL; -- corrected\n" } });
  await nextTick();
  const candidate = view.state.doc.toString();
  button(i18n.global.t("objects.saveSource"))!.click();
  const danger = useSqlExecutionDangerStore();
  await vi.waitFor(() => expect(danger.pending).toBeDefined());
  danger.confirm();
  if (lostReply) {
    await vi.waitFor(() => expect(document.body.textContent).toContain("readback offline"));
    expect(drafts.at(-1)?.triggers[0]?.original?.statement).toBe(definition);
    expect(drafts.at(-1)?.columns[0]?.name).toBe("ID_LOCAL_DRAFT");
    button(i18n.global.t("common.close"))!.click();
    await nextTick();
    await vi.waitFor(() => expect(button(i18n.global.t("structureEditor.apply"))!.disabled).toBe(false));
    expect(await structure!.applyChanges()).toBe(false);
    expect(rpc.executeBatch).not.toHaveBeenCalled();
    offline = false;
    button(i18n.global.t("oracleTrigger.refreshDraft"))!.click();
  }
  await vi.waitFor(() => expect(drafts.at(-1)?.triggers[0]?.original?.statement).toBe(candidate));
  expect(drafts.at(-1)?.columns[0]?.name).toBe("ID_LOCAL_DRAFT");
  expect(rpc.executeQuery.mock.calls.filter((call) => !call[2].startsWith("SELECT")).map((call) => call[2])).toEqual([candidate]);
  expect(rpc.listTriggers).toHaveBeenCalledWith("trigger-structure-source", "service", parent, "T", undefined, { identityMode: "exact" });
});
