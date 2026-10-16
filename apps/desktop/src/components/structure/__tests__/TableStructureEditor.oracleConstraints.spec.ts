// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TableStructureEditor from "../TableStructureEditor.vue";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { ConnectionConfig, ConstraintInfo, IndexInfo } from "@/types/database";
import type { TableStructureEditorDraft } from "@/types/database";
import * as api from "@/lib/backend/api";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listPlugins: vi.fn().mockResolvedValue([]),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  listDataTypes: vi.fn().mockResolvedValue([]),
  getColumns: vi.fn(),
  listConstraints: vi.fn(),
  listIndexes: vi.fn(),
  listForeignKeys: vi.fn().mockResolvedValue([]),
  listTriggers: vi.fn().mockResolvedValue([]),
  getTableComment: vi.fn().mockResolvedValue(""),
  getTablePartitionStatus: vi.fn().mockResolvedValue({ isPartitionedParent: false, isPartition: false, isForeign: false }),
  getTablePartitioning: vi.fn().mockResolvedValue(null),
  buildTableStructureChangeSql: vi.fn().mockResolvedValue({ statements: [], warnings: [] }),
  saveHistory: vi.fn().mockResolvedValue(undefined),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  disconnectDb: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn().mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 }),
}));

const connection = { id: "ob-constraint-edit", name: "OB constraint fixture", db_type: "oceanbase-oracle", driver_profile: "oceanbase-oracle", host: "fixture", port: 2881, username: "APP", database: "APP" } as ConnectionConfig;
let app: App | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.buildTableStructureChangeSql).mockReset().mockResolvedValue({ statements: [], warnings: [] });
  connection.db_type = "oceanbase-oracle";
  connection.driver_profile = "oceanbase-oracle";
  connection.is_production = false;
  i18n.global.locale.value = "en";
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function mountConstraintEditor(
  initialTab: "constraints" | "indexes" | "columns" = "constraints",
  indexes: IndexInfo[] = [{ name: "UQ_EMAIL", columns: ["EMAIL"], is_primary: false, is_unique: true, index_type: "NORMAL" }],
  expose?: (instance: { applyChanges: () => Promise<boolean> }) => void,
  draft?: TableStructureEditorDraft,
  indexCatalogConfigured = false,
  loadedColumns?: Array<{ name: string; data_type: string; is_nullable: boolean; is_primary_key: boolean; column_default: string | null; character_maximum_length?: number }>,
  beforeMount: (() => void) | undefined = undefined,
  events: { drafts?: unknown[]; saved?: unknown[] } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  vi.mocked(api.getColumns).mockResolvedValue(
    loadedColumns ?? [
      { name: "EMAIL", data_type: "VARCHAR2(120 BYTE)", character_maximum_length: 120, is_nullable: true, is_primary_key: false, column_default: null },
      { name: "AGE", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null },
    ],
  );
  vi.mocked(api.listConstraints).mockResolvedValue([
    {
      name: "CK_AGE",
      constraint_type: "CHECK",
      columns: [],
      definition: '"AGE" >= 0',
      ref_columns: [],
      enabled: true,
      valid: true,
      deferrable: false,
      initially_deferred: false,
      oracle_metadata: { metadataComplete: true, owner: "APP", constraintType: "C", status: "ENABLED", validated: "VALIDATED", deferrable: "NOT DEFERRABLE", deferred: "IMMEDIATE", rely: null, indexOwner: null, indexName: null, indexSharing: null, index: null },
    },
    {
      name: "UQ_EMAIL",
      constraint_type: "UNIQUE",
      columns: ["EMAIL"],
      definition: "",
      ref_columns: [],
      enabled: true,
      valid: true,
      deferrable: false,
      initially_deferred: false,
      oracle_metadata: {
        metadataComplete: true,
        owner: "APP",
        constraintType: "U",
        status: "ENABLED",
        validated: "VALIDATED",
        deferrable: "NOT DEFERRABLE",
        deferred: "IMMEDIATE",
        rely: null,
        indexOwner: "APP",
        indexName: "UQ_EMAIL",
        indexSharing: "exclusive",
        index: {
          metadataComplete: true,
          owner: "APP",
          tableOwner: "APP",
          tableName: "CONTACTS",
          indexType: "NORMAL",
          uniqueness: "UNIQUE",
          status: "VALID",
          partitioned: false,
          visibility: "VISIBLE",
          secondary: null,
          columns: ["EMAIL"],
          directions: ["ASC"],
          keyIsExpression: [false],
          includedColumns: [],
        },
      },
    },
  ] as ConstraintInfo[]);
  if (!indexCatalogConfigured) {
    if (connection.db_type === "oracle" || connection.db_type === "oceanbase-oracle") configureOracleIndexCatalog();
    vi.mocked(api.listIndexes).mockResolvedValue(indexes);
  }
  beforeMount?.();
  const container = document.createElement("div");
  document.body.append(container);
  await invalidateObjectMetadataCache({ connectionId: connection.id });
  app = createApp({
    render: () =>
      h(
        TooltipProvider,
        {},
        { default: () => h(TableStructureEditor, { connectionId: connection.id, database: "APP", schema: "APP", tableName: "CONTACTS", initialTab, ref: expose, draft, "onUpdate:draft": (value: unknown) => events.drafts?.push(value), onSaved: (...args: unknown[]) => events.saved?.push(args) }) },
      ),
  });
  app.use(pinia);
  app.use(i18n);
  app.component("LightTooltip", LightTooltip);
  app.mount(container);
  await vi.waitFor(() =>
    expect(initialTab === "constraints" ? container.textContent.includes("CK_AGE") : initialTab === "indexes" ? container.querySelector("[data-index-name-input]") : initialTab === "columns" ? container.querySelector("[data-column-row-index='0']") : false, container.textContent).toBeTruthy(),
  );
  await nextTick();
  return container;
}

type OracleIndexCatalogItem = { name: string; columns: string[]; unique: boolean; indexType: string; partitioned: string; visibility: string; directions: string[]; expressions: Array<string | null> };

function configureOracleIndexCatalog(
  failCreate: boolean | string = false,
  initial: OracleIndexCatalogItem | OracleIndexCatalogItem[] = { name: "IX_EMAIL", columns: ["EMAIL"], unique: false, indexType: "NORMAL", partitioned: "NO", visibility: "VISIBLE", directions: ["ASC"], expressions: [null] },
  indexSnapshotGate?: Promise<void>,
  onIndexSnapshotStart?: () => void,
) {
  const initialIndexes = Array.isArray(initial) ? initial : [initial];
  let catalog = [...initialIndexes];
  let lastDroppedIndex = initialIndexes[0]!;
  let rejectCreate = failCreate;
  let activeIndexSnapshotGate = indexSnapshotGate;
  const ddl: string[] = [];
  vi.mocked(api.listIndexes).mockImplementation(async () =>
    catalog.map(
      (index) =>
        ({
          name: index.name,
          columns: [...index.columns],
          is_primary: false,
          is_unique: index.unique,
          index_type: index.indexType,
          key_metadata_complete: true,
          key_is_expression: index.expressions.map((expression) => expression !== null),
          key_directions: [...index.directions],
          visibility: index.visibility,
          constraint_backed: false,
        }) as IndexInfo,
    ),
  );
  vi.mocked(api.executeQuery).mockImplementation(async (_connectionId, _database, sql) => {
    if (/^\s*DROP INDEX/i.test(sql)) {
      ddl.push(sql);
      const name = /^\s*DROP INDEX\s+(?:"(?:APP)"\.)?"((?:""|[^"])*)"/i.exec(sql)?.[1]?.replace(/""/g, '"');
      const dropped = catalog.find((index) => index.name === name);
      if (dropped) lastDroppedIndex = dropped;
      catalog = catalog.filter((index) => index.name !== name);
      return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 } as never;
    }
    if (/^\s*CREATE INDEX/i.test(sql)) {
      ddl.push(sql);
      const name = /^\s*CREATE\s+INDEX\s+"((?:""|[^"])*)"/i.exec(sql)?.[1]?.replace(/""/g, '"');
      const rejected = rejectCreate === true || (typeof rejectCreate === "string" && rejectCreate === name);
      if (!rejected && name) catalog.push({ ...lastDroppedIndex, name });
      return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, execution_error: rejected, error: rejected ? { detail: "CREATE rejected" } : undefined } as never;
    }
    if (sql.includes("SYS_CONTEXT")) return { columns: [], rows: [["APP", "APP", "ORCL"]], affected_rows: 0, execution_time_ms: 1 } as never;
    if (sql.includes("SYS.ALL_OBJECTS")) return { columns: [], rows: [["APP", "CONTACTS", 77]], affected_rows: 0, execution_time_ms: 1 } as never;
    if (sql.includes("SYS.ALL_TABLES")) return { columns: [], rows: [sql.includes(", EXTERNAL") ? [null, "N", "NO"] : [null, "N"]], affected_rows: 0, execution_time_ms: 1 } as never;
    if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) {
      if (connection.db_type === "oceanbase-oracle") throw new Error("ORA-00942: SYS.ALL_EXTERNAL_TABLES does not exist");
      return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 } as never;
    }
    if (sql.includes("SYS.ALL_TAB_COLS")) {
      const rows = sql.includes("USER_GENERATED")
        ? [
            ["EMAIL", "VARCHAR2", 120, null, null, "Y", "B", 120, "YES", "NO"],
            ["AGE", "NUMBER", 22, null, null, "Y", null, null, "YES", "NO"],
            ...catalog.flatMap((index) => index.expressions.flatMap((expression, position) => (expression === null ? [] : [[`SYS_NC${position + 1}$`, "VARCHAR2", 120, null, null, "Y", "B", 120, "NO", "YES"]]))),
          ]
        : [
            ["EMAIL", "VARCHAR2", 120, null, null, "Y"],
            ["AGE", "NUMBER", 22, null, null, "Y"],
          ];
      return { columns: [], rows, affected_rows: 0, execution_time_ms: 1 } as never;
    }
    if (sql.includes("SELECT INDEX_NAME FROM SYS.ALL_INDEXES"))
      return {
        columns: [],
        rows: catalog
          .map((index) => index.name)
          .sort()
          .map((name) => [name]),
        affected_rows: 0,
        execution_time_ms: 1,
      } as never;
    if (sql.includes("SYS.ALL_IND_COLUMNS")) {
      onIndexSnapshotStart?.();
      if (activeIndexSnapshotGate) await activeIndexSnapshotGate;
      return {
        columns: [],
        rows: [...catalog]
          .sort((left, right) => left.name.localeCompare(right.name))
          .flatMap((index) =>
            index.columns.map((column, position) => [
              "APP",
              index.name,
              "APP",
              "CONTACTS",
              index.indexType,
              index.unique ? "UNIQUE" : "NONUNIQUE",
              "VALID",
              index.partitioned === "YES" ? "YES" : "NO",
              index.visibility,
              "N",
              index.expressions[position] === null ? column : `SYS_NC${position + 1}$`,
              index.directions[position],
              index.expressions[position],
            ]),
          ),
        affected_rows: 0,
        execution_time_ms: 1,
      } as never;
    }
    if (sql.includes("SYS.ALL_CONSTRAINTS")) return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 } as never;
    throw new Error(`Unhandled Oracle index fixture query: ${sql}`);
  });
  return {
    ddl,
    setCatalog: (value: typeof catalog) => (catalog = value),
    setRejectCreate: (value: boolean | string) => (rejectCreate = value),
    setIndexSnapshotGate: (value: Promise<void> | undefined, onStart?: () => void) => {
      activeIndexSnapshotGate = value;
      onIndexSnapshotStart = onStart;
    },
  };
}

describe("Oracle CHECK and UNIQUE entry points", () => {
  it("opens a delete draft without executing SQL", async () => {
    const container = await mountConstraintEditor();
    const deleteCheck = container.querySelector<HTMLButtonElement>('[data-constraint-delete="CK_AGE"]');
    expect(deleteCheck).toBeTruthy();
    const queryCount = vi.mocked(api.executeQuery).mock.calls.length;
    deleteCheck!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-constraint-editor="CK_AGE"]')).toBeTruthy());
    expect(vi.mocked(api.executeQuery).mock.calls.length).toBe(queryCount);
  });

  it("opens a new CHECK draft from the constraints toolbar", async () => {
    const container = await mountConstraintEditor();
    const addCheck = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Add CHECK Constraint"));
    expect(addCheck).toBeTruthy();
    addCheck!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-constraint-editor="new"]')).toBeTruthy());
  });

  it("opens a new UNIQUE draft from the constraints toolbar", async () => {
    const container = await mountConstraintEditor();
    const addUnique = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Add UNIQUE Constraint"));
    expect(addUnique).toBeTruthy();
    addUnique!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-constraint-editor="new"]')).toBeTruthy());
  });

  it("opens the CHECK editor from its constraint card", async () => {
    const container = await mountConstraintEditor();
    const checkEdit = container.querySelector<HTMLButtonElement>('[aria-label="Edit constraint CK_AGE"]');
    expect(checkEdit).toBeTruthy();
    checkEdit!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-constraint-editor="CK_AGE"]')).toBeTruthy());
  });

  it.each(["history", "refresh", "same-session"] as const)("handles CHECK results correctly when the connection is %s", async (pendingAt) => {
    let dropped = false;
    let componentRefreshStarted = false;
    let historySaved = false;
    let releaseHistory!: () => void;
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const refreshStartedPromise = new Promise<void>((resolve) => (refreshStarted = resolve));
    const check = {
      name: "CK_AGE",
      constraint_type: "CHECK",
      columns: [],
      definition: '"AGE" >= 0',
      ref_columns: [],
      enabled: true,
      valid: true,
      deferrable: false,
      initially_deferred: false,
      oracle_metadata: { metadataComplete: true, owner: "APP", constraintType: "C", status: "ENABLED", validated: "VALIDATED", deferrable: "NOT DEFERRABLE", deferred: "IMMEDIATE", rely: null, indexOwner: null, indexName: null, indexSharing: null, index: null },
    } as ConstraintInfo;
    const beforeMount = () => {
      vi.mocked(api.buildTableStructureChangeSql).mockImplementation(async (options) => ({ statements: options.oracleConstraintChanges?.length ? ['ALTER TABLE "APP"."CONTACTS" DROP CONSTRAINT "CK_AGE";'] : [], warnings: [] }) as never);
      vi.mocked(api.getColumns).mockImplementation(async () => {
        if (dropped && pendingAt === "refresh") {
          componentRefreshStarted = true;
        }
        return [
          { name: "EMAIL", data_type: "VARCHAR2(120 BYTE)", character_maximum_length: 120, is_nullable: true, is_primary_key: false, column_default: null },
          { name: "AGE", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null },
        ];
      });
      vi.mocked(api.listConstraints).mockImplementation(async () => {
        if (dropped) {
          if (pendingAt === "refresh" && componentRefreshStarted) {
            refreshStarted();
            return new Promise((resolve) => {
              releaseRefresh = () => resolve([] as never);
            });
          }
          return [];
        }
        return [check];
      });
      vi.mocked(api.saveHistory).mockImplementation(async () => {
        if (pendingAt === "history") await new Promise<void>((resolve) => (releaseHistory = resolve));
        historySaved = true;
      });
      const baseExecute = vi.mocked(api.executeQuery).getMockImplementation();
      vi.mocked(api.executeQuery).mockImplementation(async (connectionId, database, sql, schema, bindValues, options) => {
        if (sql.startsWith("ALTER TABLE") && sql.includes('DROP CONSTRAINT "CK_AGE"')) {
          dropped = true;
          return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 } as never;
        }
        return baseExecute!(connectionId, database, sql, schema, bindValues, options);
      });
    };
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    const drafts: unknown[] = [];
    const saved: unknown[] = [];
    const container = await mountConstraintEditor("constraints", undefined, (instance) => (editor = instance), undefined, false, undefined, beforeMount, { drafts, saved });
    const store = useConnectionStore();
    const deleteCheck = container.querySelector<HTMLButtonElement>('[data-constraint-delete="CK_AGE"]');
    expect(deleteCheck).toBeTruthy();
    deleteCheck!.click();
    await vi.waitFor(() => expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.some(([options]) => options.oracleConstraintChanges?.length)).toBe(true));
    const draftUpdatesBeforeSave = drafts.length;

    const pendingSave = editor!.applyChanges();
    if (pendingAt === "history") await vi.waitFor(() => expect(api.saveHistory).toHaveBeenCalled());
    else if (pendingAt === "refresh") {
      await refreshStartedPromise;
      expect(historySaved).toBe(true);
    }
    if (pendingAt !== "same-session") {
      const disconnecting = store.disconnect(connection.id, { skipTabHandling: true, markClosedByUser: false });
      if (pendingAt === "history") releaseHistory();
      else releaseRefresh();
      await disconnecting;
    }
    const outcome = await pendingSave;

    if (pendingAt === "same-session") {
      expect(outcome).toBe(true);
      expect(saved).toEqual([[false]]);
      expect(drafts.length).toBeGreaterThan(draftUpdatesBeforeSave);
      expect(container.querySelector('[data-constraint-delete="CK_AGE"]')).toBeNull();
    } else {
      expect(outcome).toBe(false);
      expect(saved).toEqual([]);
      expect(drafts).toHaveLength(draftUpdatesBeforeSave);
    }
  });

  it("opens the UNIQUE editor from its constraint card", async () => {
    const container = await mountConstraintEditor();
    const uniqueEdit = container.querySelector<HTMLButtonElement>('[aria-label="Edit constraint UQ_EMAIL"]');
    expect(uniqueEdit).toBeTruthy();
    uniqueEdit!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-constraint-editor="UQ_EMAIL"]')).toBeTruthy());
  });

  it("opens the same UNIQUE draft from its paired index entry", async () => {
    const container = await mountConstraintEditor("indexes");
    await vi.waitFor(() => expect(container.querySelector("[data-index-name-input]")).toBeTruthy());

    const editConstraint = container.querySelector<HTMLButtonElement>('[data-paired-unique-constraint="UQ_EMAIL"]');
    expect(editConstraint).toBeTruthy();
    editConstraint!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-constraint-editor="UQ_EMAIL"]')).toBeTruthy());
  });

  it("passes loaded Oracle key metadata through the index rebuild preview", async () => {
    connection.db_type = "oracle";
    connection.driver_profile = "oracle";
    const container = await mountConstraintEditor("indexes", [
      {
        name: "IX_EVENT_EXPR",
        columns: ["LOWER(EVENT_NAME)", "EVENT_TS"],
        is_primary: false,
        is_unique: false,
        index_type: "FUNCTION-BASED NORMAL",
        key_is_expression: [true, false],
        key_directions: ["DESC", "ASC"],
        visibility: "INVISIBLE",
        key_metadata_complete: true,
      } as unknown as IndexInfo,
    ]);
    const input = container.querySelector<HTMLInputElement>("[data-index-name-input]")!;
    input.value = "IX_EVENT_EXPR_RENAMED";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() => {
      const options = vi.mocked(api.buildTableStructureChangeSql).mock.calls.map(([value]) => value);
      expect(options.some((value) => value.indexes?.[0]?.name === "IX_EVENT_EXPR_RENAMED")).toBe(true);
    });
    const options = vi
      .mocked(api.buildTableStructureChangeSql)
      .mock.calls.map(([value]) => value)
      .find((value) => value.indexes?.[0]?.name === "IX_EVENT_EXPR_RENAMED")!;
    expect(options.indexes?.[0]?.original).toMatchObject({
      key_is_expression: [true, false],
      key_directions: ["DESC", "ASC"],
      visibility: "INVISIBLE",
    });
  });
});

describe("Oracle independent index execution", () => {
  const loadedIndex = {
    name: "IX_EMAIL",
    columns: ["EMAIL"],
    is_primary: false,
    is_unique: false,
    index_type: "NORMAL",
    key_metadata_complete: true,
    key_is_expression: [false],
    key_directions: ["ASC"],
    visibility: "VISIBLE",
    constraint_backed: false,
  } as IndexInfo;

  async function prepareRename(
    failCreate = false,
    index: IndexInfo = loadedIndex,
    initialCatalog = { name: "IX_EMAIL", columns: ["EMAIL"], unique: false, indexType: "NORMAL", partitioned: "NO", visibility: "VISIBLE", directions: ["ASC"], expressions: [null] as Array<string | null> },
    expose?: (instance: { applyChanges: () => Promise<boolean> }) => void,
    initialTab: "constraints" | "indexes" | "columns" = "indexes",
    draft?: TableStructureEditorDraft,
    loadedColumns?: Array<{ name: string; data_type: string; is_nullable: boolean; is_primary_key: boolean; column_default: string | null; character_maximum_length?: number }>,
    indexSnapshotGate?: Promise<void>,
    onIndexSnapshotStart?: () => void,
  ) {
    connection.db_type = "oracle";
    connection.driver_profile = "oracle";
    const fixture = configureOracleIndexCatalog(failCreate, initialCatalog, indexSnapshotGate, onIndexSnapshotStart);
    const container = await mountConstraintEditor(initialTab, [index], expose, draft, true, loadedColumns);
    configureIndexRenamePreview();
    const input = container.querySelector<HTMLInputElement>("[data-index-name-input]");
    if (input) {
      input.value = "IX_EMAIL_RENAMED";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (input) await vi.waitFor(() => expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.length).toBeGreaterThan(0));
    return { container, fixture };
  }

  function configureIndexRenamePreview() {
    vi.mocked(api.buildTableStructureChangeSql).mockImplementation(async (options) => {
      const draft = options.indexes?.[0];
      const targetName = draft?.name || "IX_EMAIL_RENAMED";
      const original = draft?.original;
      const keys = (draft?.columns || ["EMAIL"])
        .map((column) => {
          const originalPosition = original?.columns.indexOf(column) ?? -1;
          const expression = originalPosition >= 0 && original?.key_is_expression?.[originalPosition] ? column : `"${column}"`;
          const direction = originalPosition >= 0 ? original?.key_directions?.[originalPosition] || "ASC" : "ASC";
          return `${expression} ${direction}`;
        })
        .join(", ");
      const visibility = original?.visibility === "INVISIBLE" ? " INVISIBLE" : "";
      const create = `CREATE ${draft?.isUnique ? "UNIQUE " : ""}INDEX "${targetName}" ON "APP"."CONTACTS" (${keys})${visibility};`;
      return {
        statements: original && !draft?.oracleOriginalMissing ? [`DROP INDEX "APP"."${original.name}";`, create] : [create],
        warnings: [],
      } as never;
    });
  }

  it("compares the loaded original before the first DDL", async () => {
    const { container, fixture } = await prepareRename();
    fixture.setCatalog([{ name: "IX_EMAIL", columns: ["AGE"], unique: false, indexType: "NORMAL", partitioned: "NO", visibility: "VISIBLE", directions: ["ASC"], expressions: [null] }]);

    const apply = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Apply"))!;
    apply.click();

    await vi.waitFor(() => expect(container.textContent).toContain("Index metadata changed"));
    expect(fixture.ddl).toEqual([]);
  });

  it("does not publish a ready baseline when loaded columns disagree with the dictionary snapshot", async () => {
    connection.is_production = true;
    const { container, fixture } = await prepareRename(false, loadedIndex, undefined, undefined, "indexes", undefined, [
      { name: "EMAIL", data_type: "VARCHAR2(121 BYTE)", character_maximum_length: 121, is_nullable: true, is_primary_key: false, column_default: null },
      { name: "AGE", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null },
    ]);
    await vi.waitFor(() => expect(vi.mocked(api.executeQuery).mock.calls.some(([, , sql]) => sql.includes("SYS.ALL_IND_COLUMNS"))).toBe(true));

    const apply = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Apply"))!;
    apply.click();

    await vi.waitFor(() => expect(container.textContent).toContain("not ready for a safe save"));
    expect(useProductionSafetyStore().pending).toBeUndefined();
    expect(fixture.ddl).toEqual([]);
  });

  it("blocks an index rebuild mixed with a column change", async () => {
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    const originalColumn = { name: "EMAIL", data_type: "VARCHAR2(120)", is_nullable: true, is_primary_key: false, column_default: null };
    const columnDraft = { id: "EMAIL", name: "EMAIL", dataType: "VARCHAR2(120)", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, original: originalColumn, markedForDrop: false };
    const indexDraft = { id: "IX_EMAIL", name: "IX_EMAIL_RENAMED", columns: ["EMAIL"], isUnique: false, isPrimary: false, filter: "", indexType: "NORMAL", includedColumns: [], comment: "", original: loadedIndex, markedForDrop: false };
    const draft = {
      dirty: true,
      activeTab: "columns",
      newTableName: "",
      tableComment: "",
      originalTableComment: "",
      columns: [columnDraft],
      indexes: [indexDraft],
      foreignKeys: [],
      triggers: [],
      loadedMetadataFacets: ["columns", "indexes"],
      initialized: true,
    } as unknown as TableStructureEditorDraft;
    const container = await mountConstraintEditor(
      "columns",
      [loadedIndex],
      (instance) => {
        editor = instance;
      },
      draft,
    );
    const fixture = configureOracleIndexCatalog();
    vi.mocked(api.buildTableStructureChangeSql).mockResolvedValue({ statements: ['ALTER TABLE "CONTACTS" MODIFY "EMAIL" NOT NULL;', 'DROP INDEX "IX_EMAIL";', 'CREATE INDEX "IX_EMAIL_RENAMED" ON "APP"."CONTACTS" ("EMAIL" ASC);'], warnings: [] } as never);
    await vi.waitFor(() => expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.length).toBeGreaterThan(0));

    expect(await editor!.applyChanges()).toBe(false);
    expect(container.textContent).toContain("Apply Oracle-family index changes separately");
    expect(fixture.ddl).toEqual([]);
  });

  it("does not replay DROP after CREATE rejection until refreshed", async () => {
    const { container, fixture } = await prepareRename(true);
    const apply = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Apply"))!;
    apply.click();
    await vi.waitFor(() => expect(fixture.ddl).toHaveLength(2));
    await vi.waitFor(() => expect(document.body.textContent).toContain("CREATE rejected"));

    const refresh = container.querySelector<HTMLButtonElement>("[data-refresh-structure-shortcut]")!;
    refresh.click();
    await vi.waitFor(() => expect(vi.mocked(api.listIndexes).mock.calls.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("[data-index-name-input]")?.value).toBe("IX_EMAIL_RENAMED"));
    await vi.waitFor(() => expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.some(([options]) => options.indexes?.some((index) => index.name === "IX_EMAIL_RENAMED" && index.oracleOriginalMissing && index.original?.name === "IX_EMAIL"))).toBe(true));
    fixture.setRejectCreate(false);
    apply.click();
    await vi.waitFor(() => expect(fixture.ddl).toHaveLength(3));
    expect(fixture.ddl[2]).toMatch(/^CREATE INDEX/);
  });

  it("recreates a missing index when the user restores its original definition", async () => {
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    const { container, fixture } = await prepareRename(true, loadedIndex, undefined, (instance) => {
      editor = instance;
    });
    const apply = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Apply"))!;
    apply.click();
    await vi.waitFor(() => expect(fixture.ddl).toHaveLength(2));

    const close = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "Close");
    close?.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await nextTick();
    expect(Array.from(container.querySelectorAll<HTMLElement>("[role=tab]")).find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toContain("Indexes");
    const refresh = container.querySelector<HTMLButtonElement>("[data-refresh-structure-shortcut]")!;
    expect(refresh.disabled).toBe(false);
    refresh.click();
    await vi.waitFor(() => expect(vi.mocked(api.listIndexes).mock.calls.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("[data-index-name-input]")?.value).toBe("IX_EMAIL_RENAMED"));
    const input = container.querySelector<HTMLInputElement>("[data-index-name-input]")!;
    const buildCallsBeforeRenameBack = vi.mocked(api.buildTableStructureChangeSql).mock.calls.length;
    input.value = "IX_EMAIL";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.length).toBeGreaterThan(buildCallsBeforeRenameBack));
    await vi.waitFor(() => expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.at(-1)?.[0].indexes?.[0]).toMatchObject({ name: "IX_EMAIL", oracleOriginalMissing: true }));
    await vi.waitFor(() => expect(container.textContent).toContain('CREATE INDEX "IX_EMAIL"'));
    fixture.setRejectCreate(false);

    const indexReadsBeforeRestore = vi.mocked(api.listIndexes).mock.calls.length;
    const restored = await editor!.applyChanges();
    expect(restored).toBe(true);
    expect(vi.mocked(api.listIndexes).mock.calls.length).toBe(indexReadsBeforeRestore + 1);
    await vi.waitFor(() => expect(fixture.ddl).toHaveLength(3));
    expect(fixture.ddl[2]).toMatch(/^CREATE INDEX "IX_EMAIL"/);
  });

  it("retains function-key and INVISIBLE metadata after a partial rename and refresh", async () => {
    const functionIndex = {
      ...loadedIndex,
      columns: ["LOWER(EMAIL)"],
      index_type: "FUNCTION-BASED NORMAL",
      key_is_expression: [true],
      key_directions: ["ASC"],
      visibility: "INVISIBLE",
    } as IndexInfo;
    const initialCatalog = {
      name: "IX_EMAIL",
      columns: ["LOWER(EMAIL)"],
      unique: false,
      indexType: "FUNCTION-BASED NORMAL",
      partitioned: "NO",
      visibility: "INVISIBLE",
      directions: ["ASC"],
      expressions: ["LOWER(EMAIL)"],
    };
    const { container, fixture } = await prepareRename(true, functionIndex, initialCatalog);
    const apply = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Apply"))!;
    apply.click();
    await vi.waitFor(() => expect(fixture.ddl).toHaveLength(2));

    const close = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "Close");
    close?.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await nextTick();
    expect(Array.from(container.querySelectorAll<HTMLElement>("[role=tab]")).find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toContain("Indexes");
    const refresh = container.querySelector<HTMLButtonElement>("[data-refresh-structure-shortcut]")!;
    expect(refresh.disabled).toBe(false);
    refresh.click();
    await vi.waitFor(() => expect(vi.mocked(api.listIndexes).mock.calls.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("[data-index-name-input]")?.value).toBe("IX_EMAIL_RENAMED"));
    const retryDraft = vi
      .mocked(api.buildTableStructureChangeSql)
      .mock.calls.map(([options]) => options.indexes?.[0])
      .find((index) => index?.oracleOriginalMissing);
    expect(retryDraft?.original).toMatchObject({ key_is_expression: [true], key_directions: ["ASC"], visibility: "INVISIBLE" });

    fixture.setRejectCreate(false);
    apply.click();
    await vi.waitFor(() => expect(fixture.ddl).toHaveLength(3));
    expect(fixture.ddl[2]).toContain("LOWER(EMAIL) ASC");
    expect(fixture.ddl[2]).toContain("INVISIBLE");
    expect(fixture.ddl[2]).not.toMatch(/^DROP INDEX/);
  });

  it("rejects a column type change made while production confirmation is pending", async () => {
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    connection.is_production = true;
    const { container, fixture } = await prepareRename(false, loadedIndex, undefined, (instance) => {
      editor = instance;
    });
    const pending = editor!.applyChanges();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending, container.textContent).toBeDefined());
    const columnsTab = Array.from(container.querySelectorAll<HTMLElement>("[role=tab]")).find((tab) => tab.textContent?.includes("Columns"));
    expect(columnsTab).toBeTruthy();
    container.querySelector<HTMLElement>('[role=tab][aria-selected="true"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await vi.waitFor(() => expect(columnsTab!.getAttribute("aria-selected")).toBe("true"));
    await vi.waitFor(() => expect(container.querySelector("[data-column-row-index='0']")).toBeTruthy());
    const typeTrigger = container.querySelector<HTMLElement>("[data-column-row-index='0'] .dbx-searchable-select-trigger");
    expect(typeTrigger).toBeTruthy();
    typeTrigger!.click();
    await vi.waitFor(() => expect(document.querySelector(".dbx-searchable-select-list")).toBeTruthy());
    const searchInput = document.querySelector<HTMLInputElement>(".dbx-searchable-select-list")?.parentElement?.querySelector("input");
    expect(searchInput).toBeTruthy();
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setInputValue?.call(searchInput, "VARCHAR2(40 CHAR)");
    searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const customOption = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.title === "VARCHAR2(40 CHAR)");
    expect(customOption).toBeTruthy();
    customOption!.click();
    await nextTick();
    expect(container.querySelector<HTMLInputElement>("[data-column-row-index='0'] input")?.value).toBe("EMAIL");
    expect(Array.from(container.querySelectorAll<HTMLInputElement>("[data-column-row-index='0'] input")).map((input) => input.value)).toContain("40");
    expect(container.querySelector("[data-column-row-index='0']")?.textContent).toContain("CHAR");
    safety.confirm();
    await expect(pending).resolves.toBe(false);
    expect(fixture.ddl).toEqual([]);
  });

  it("retains a dirty column draft when the Indexes tab lazily refreshes metadata", async () => {
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    const { container, fixture } = await prepareRename(
      false,
      loadedIndex,
      undefined,
      (instance) => {
        editor = instance;
      },
      "columns",
    );
    const typeTrigger = container.querySelector<HTMLElement>("[data-column-row-index='0'] .dbx-searchable-select-trigger")!;
    typeTrigger.click();
    await vi.waitFor(() => expect(document.querySelector(".dbx-searchable-select-list")).toBeTruthy());
    const searchInput = document.querySelector(".dbx-searchable-select-list")!.parentElement!.querySelector<HTMLInputElement>("input")!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setInputValue?.call(searchInput, "VARCHAR2(40 CHAR)");
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.title === "VARCHAR2(40 CHAR)")!
      .click();
    await nextTick();
    const indexesTab = Array.from(container.querySelectorAll<HTMLElement>("[role=tab]")).find((tab) => tab.textContent?.includes("Indexes"))!;
    container.querySelector<HTMLElement>("[role=tab][aria-selected=true]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(indexesTab.getAttribute("aria-selected")).toBe("true"));
    await vi.waitFor(() => expect(container.querySelector("[data-index-name-input]")).toBeTruthy());
    container.querySelector<HTMLElement>("[role=tab][aria-selected=true]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await vi.waitFor(() => expect(Array.from(container.querySelectorAll<HTMLInputElement>("[data-column-row-index='0'] input")).map((input) => input.value)).toContain("40"));
    container.querySelector<HTMLElement>("[role=tab][aria-selected=true]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(indexesTab.getAttribute("aria-selected")).toBe("true"));
    const indexName = container.querySelector<HTMLInputElement>("[data-index-name-input]")!;
    indexName.value = "IX_EMAIL_RENAMED";
    indexName.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(vi.mocked(api.buildTableStructureChangeSql).mock.calls.some(([options]) => options.indexes?.[0]?.name === "IX_EMAIL_RENAMED")).toBe(true));
    expect(await editor!.applyChanges()).toBe(false);
    expect(fixture.ddl).toEqual([]);
  });

  it("invalidates confirmation eligibility while a columns-only refresh is pending", async () => {
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    connection.is_production = true;
    const { container, fixture } = await prepareRename(false, loadedIndex, undefined, (instance) => {
      editor = instance;
    });
    container.querySelector<HTMLElement>("[role=tab][aria-selected=true]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await vi.waitFor(() => expect(container.querySelector("[data-column-row-index='0']")).toBeTruthy());
    let releaseColumns!: () => void;
    const columnsGate = new Promise<void>((resolve) => {
      releaseColumns = resolve;
    });
    vi.mocked(api.getColumns).mockImplementationOnce(async () => {
      await columnsGate;
      return [
        { name: "EMAIL", data_type: "VARCHAR2(120 BYTE)", character_maximum_length: 120, is_nullable: true, is_primary_key: false, column_default: null },
        { name: "AGE", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null },
      ] as never;
    });
    useQueryStore().invalidateTableStructure(connection.id, "APP", "APP", "CONTACTS");
    await vi.waitFor(() => expect(releaseColumns).toBeTypeOf("function"));

    expect(await editor!.applyChanges()).toBe(false);
    expect(useProductionSafetyStore().pending).toBeUndefined();
    expect(fixture.ddl).toEqual([]);
    releaseColumns();
  });

  it("blocks Apply until the index snapshot request finishes, then allows the same draft", async () => {
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    let snapshotStarted!: () => void;
    let releaseSnapshot!: () => void;
    const snapshotStartedPromise = new Promise<void>((resolve) => {
      snapshotStarted = resolve;
    });
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    connection.db_type = "oracle";
    connection.driver_profile = "oracle";
    connection.is_production = true;
    const fixture = configureOracleIndexCatalog(false, undefined, snapshotGate, snapshotStarted);
    const container = await mountConstraintEditor(
      "constraints",
      undefined,
      (instance) => {
        editor = instance;
      },
      undefined,
      true,
    );
    configureIndexRenamePreview();
    await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>("[data-refresh-structure-shortcut]")?.disabled).toBe(false));
    const indexesTab = Array.from(container.querySelectorAll<HTMLElement>("[role=tab]")).find((tab) => tab.textContent?.includes("Indexes"));
    expect(indexesTab).toBeTruthy();
    container.querySelector<HTMLElement>('[role=tab][aria-selected="true"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await vi.waitFor(() => expect(Array.from(container.querySelectorAll<HTMLElement>("[role=tab]")).find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toContain("Foreign Keys"));
    container.querySelector<HTMLElement>('[role=tab][aria-selected="true"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await vi.waitFor(() => expect(indexesTab!.getAttribute("aria-selected")).toBe("true"));
    await Promise.race([snapshotStartedPromise, new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`index snapshot did not start after lazy tab load; listIndexes=${vi.mocked(api.listIndexes).mock.calls.length}`)), 1500))]);
    expect(container.querySelector("[data-index-name-input]")).toBeTruthy();
    const indexName = container.querySelector<HTMLInputElement>("[data-index-name-input]")!;
    const previewsBeforeEdit = vi.mocked(api.buildTableStructureChangeSql).mock.calls.length;
    indexName.value = "IX_EMAIL_RENAMED";
    indexName.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(api.buildTableStructureChangeSql)
          .mock.calls.slice(previewsBeforeEdit)
          .some(([options]) => options.indexes?.[0]?.name === "IX_EMAIL_RENAMED"),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Apply Changes"))?.disabled).toBe(false));
    expect(await editor!.applyChanges()).toBe(false);
    expect(useProductionSafetyStore().pending).toBeUndefined();
    expect(fixture.ddl).toEqual([]);
    expect(container.textContent).toContain("Index metadata is not ready for a safe save");
    releaseSnapshot();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const safety = useProductionSafetyStore();
    const applying = editor!.applyChanges();
    const applyResult = await Promise.race([applying.then((result) => ({ result })), new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 5000))]);
    expect(safety.pending, `post-release apply outcome=${JSON.stringify(applyResult)}; message=${container.textContent}`).toBeDefined();
    safety.confirm();
    await expect(applying).resolves.toBe(true);
    await vi.waitFor(() => expect(fixture.ddl).toHaveLength(2));
    expect(container.textContent).not.toContain("Index metadata is not ready for a safe save");
  });

  it("does not replace a dirty restored column draft during background cache revalidation", async () => {
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    let revalidationStarted!: () => void;
    let releaseRevalidation!: () => void;
    const started = new Promise<void>((resolve) => {
      revalidationStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRevalidation = resolve;
    });
    const originalColumn = { name: "EMAIL", data_type: "VARCHAR2(120 BYTE)", character_maximum_length: 120, is_nullable: true, is_primary_key: false, column_default: null };
    const draft = {
      dirty: false,
      activeTab: "columns",
      newTableName: "",
      tableComment: "",
      originalTableComment: "",
      columns: [{ id: "EMAIL", name: "EMAIL", dataType: "VARCHAR2(120 BYTE)", isNullable: true, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, original: originalColumn, markedForDrop: false }],
      indexes: [{ id: "IX_EMAIL", name: "IX_EMAIL", columns: ["EMAIL"], isUnique: false, isPrimary: false, filter: "", indexType: "NORMAL", includedColumns: [], comment: "", original: loadedIndex, markedForDrop: false }],
      foreignKeys: [],
      triggers: [],
      loadedMetadataFacets: ["columns", "indexes", "comment"],
      initialized: true,
    } as unknown as TableStructureEditorDraft;
    const fixture = configureOracleIndexCatalog();
    const container = await mountConstraintEditor(
      "columns",
      [loadedIndex],
      (instance) => {
        editor = instance;
      },
      draft,
      true,
      undefined,
      () => {
        vi.mocked(api.getColumns).mockImplementationOnce(async () => {
          revalidationStarted();
          await gate;
          return [
            { ...originalColumn, data_type: "VARCHAR2(80 BYTE)", character_maximum_length: 80 },
            { name: "AGE", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null },
          ] as never;
        });
      },
    );
    await started;
    const typeTrigger = container.querySelector<HTMLElement>("[data-column-row-index='0'] .dbx-searchable-select-trigger")!;
    typeTrigger.click();
    await vi.waitFor(() => expect(document.querySelector(".dbx-searchable-select-list")).toBeTruthy());
    const searchInput = document.querySelector(".dbx-searchable-select-list")!.parentElement!.querySelector<HTMLInputElement>("input")!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setInputValue?.call(searchInput, "VARCHAR2(40 CHAR)");
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.title === "VARCHAR2(40 CHAR)")!
      .click();
    await nextTick();
    releaseRevalidation();
    await vi.waitFor(() => expect(vi.mocked(api.saveSchemaCache).mock.calls.length).toBeGreaterThan(0));
    expect(Array.from(container.querySelectorAll<HTMLInputElement>("[data-column-row-index='0'] input")).map((input) => input.value)).toContain("40");

    expect(await editor!.applyChanges()).toBe(false);
    expect(fixture.ddl).toEqual([]);
  });

  it("ignores a late failed column request after a newer refresh publishes its baseline", async () => {
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    connection.is_production = true;
    const { container, fixture } = await prepareRename(false, loadedIndex, undefined, (instance) => {
      editor = instance;
    });
    const queryStore = useQueryStore();
    let newerSnapshotStarted!: () => void;
    const newerSnapshotStartedPromise = new Promise<void>((resolve) => {
      newerSnapshotStarted = resolve;
    });
    fixture.setIndexSnapshotGate(undefined, newerSnapshotStarted);
    let rejectOldColumns!: (error: Error) => void;
    let oldColumnsStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      oldColumnsStarted = resolve;
    });
    vi.mocked(api.getColumns).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOldColumns = reject;
          oldColumnsStarted();
        }) as never,
    );
    const callsBeforeOld = vi.mocked(api.getColumns).mock.calls.length;
    queryStore.invalidateTableStructure(connection.id, "APP", "APP", "CONTACTS");
    await oldStarted;
    await invalidateObjectMetadataCache({ connectionId: connection.id, database: "APP", schema: "APP", tableName: "CONTACTS" });
    vi.mocked(api.getColumns).mockResolvedValueOnce([
      { name: "EMAIL", data_type: "VARCHAR2(120 BYTE)", character_maximum_length: 120, is_nullable: true, is_primary_key: false, column_default: null },
      { name: "AGE", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null },
    ]);
    queryStore.invalidateTableStructure(connection.id, "APP", "APP", "CONTACTS");
    await vi.waitFor(() => expect(vi.mocked(api.getColumns).mock.calls.length).toBeGreaterThan(callsBeforeOld + 1));
    await newerSnapshotStartedPromise;
    await vi.waitFor(() => expect(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Add Index"))?.disabled).toBe(false));
    await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>("[data-refresh-structure-shortcut]")?.disabled).toBe(false));

    const indexName = container.querySelector<HTMLInputElement>("[data-index-name-input]")!;
    const previewsBeforeEdit = vi.mocked(api.buildTableStructureChangeSql).mock.calls.length;
    indexName.value = "IX_EMAIL_RENAMED";
    indexName.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(api.buildTableStructureChangeSql)
          .mock.calls.slice(previewsBeforeEdit)
          .some(([options]) => options.indexes?.[0]?.name === "IX_EMAIL_RENAMED"),
      ).toBe(true),
    );
    const applying = editor!.applyChanges();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());

    rejectOldColumns(new Error("stale columns request failed"));
    await nextTick();
    expect(container.textContent).not.toContain("stale columns request failed");
    expect(safety.pending).toBeDefined();
    safety.confirm();
    await expect(applying).resolves.toBe(true);
    await vi.waitFor(() => expect(fixture.ddl).toHaveLength(2));
    expect(fixture.ddl).toHaveLength(2);
    expect(container.querySelector<HTMLInputElement>("[data-index-name-input]")?.value).toBe("IX_EMAIL_RENAMED");
  });

  it("returns false and preserves the index draft when post-DDL column readback mismatches", async () => {
    let editor: { applyChanges: () => Promise<boolean> } | undefined;
    const { container, fixture } = await prepareRename(false, loadedIndex, undefined, (instance) => {
      editor = instance;
    });
    vi.mocked(api.getColumns).mockResolvedValueOnce([
      { name: "EMAIL", data_type: "VARCHAR2(121 BYTE)", character_maximum_length: 121, is_nullable: true, is_primary_key: false, column_default: null },
      { name: "AGE", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null },
    ]);

    expect(await editor!.applyChanges()).toBe(false);
    expect(fixture.ddl).toHaveLength(2);
    expect(container.querySelector<HTMLInputElement>("[data-index-name-input]")?.value).toBe("IX_EMAIL_RENAMED");
    expect(document.body.textContent).toContain("committed");
    expect(document.body.textContent).toContain("Readback failed or did not match the intended result");
  });
});
