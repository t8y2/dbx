// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataCompareDialog from "@/components/diff/DataCompareDialog.vue";
import { createDataCompareSelection } from "@/lib/dataGrid/dataCompareSelection";
import type { DataCompareSession, DataCompareTableResult } from "@/composables/useDataCompareSession";

const SOURCE_CONNECTION_ID = "oracle-11g";
const TARGET_CONNECTION_ID = "oracle-jdbc-11g";

interface MockColumn {
  name: string;
  data_type: string;
  is_primary_key: boolean;
}

function column(name: string, isPrimaryKey = false): MockColumn {
  return { name, data_type: "NUMBER", is_primary_key: isPrimaryKey };
}

const TABLES: Record<string, { source: MockColumn[]; target: MockColumn[] }> = {
  EVENTS: {
    source: [column("ID", true), column("TITLE"), column("CREATED_AT"), column("UPDATED_AT"), column("UPDATED_BY")],
    target: [column("ID", true), column("TITLE"), column("CREATED_AT"), column("UPDATED_AT"), column("UPDATED_BY")],
  },
  NOTES: {
    source: [column("NOTE_ID", true), column("BODY"), column("GMT_CREATE")],
    target: [column("NOTE_ID", true), column("BODY")],
  },
};

const TABLE_NAMES = Object.keys(TABLES);

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  getColumns: vi.fn(),
  buildDataCompareSyncPlan: vi.fn(),
  executeBatch: vi.fn(),
  prepareDataCompareFromTables: vi.fn(),
  prepareDataCompareMissingTarget: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  session: null as DataCompareSession | null,
}));

vi.mock("@/composables/useDataCompareSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataCompareSession")>();
  return {
    ...actual,
    getDataCompareSession: (id: string | null | undefined) => (id && sessionMocks.session?.id === id ? sessionMocks.session : undefined),
  };
});

vi.mock("@/stores/connectionStore", () => {
  const connections = [
    { id: "oracle-11g", name: "Oracle XE 11g", db_type: "oracle", driver_profile: "oracle", database: "XE" },
    {
      id: "oracle-jdbc-11g",
      name: "Oracle JDBC 11g",
      db_type: "jdbc",
      driver_profile: "oracle",
      connection_string: "jdbc:oracle:thin:@//localhost:1521/XE",
      jdbc_driver_class: "oracle.jdbc.OracleDriver",
    },
  ];
  return {
    useConnectionStore: () => ({
      connections,
      sidebarLayout: {
        groups: [{ id: "oracle", name: "Oracle", collapsed: false }],
        order: [{ type: "group", id: "oracle", children: connections.map((connection) => ({ type: "connection", id: connection.id })) }],
      },
      getConfig: (id: string) => connections.find((connection) => connection.id === id),
      ensureConnected: mocks.ensureConnected,
    }),
  };
});

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  buildDataCompareSyncPlan: mocks.buildDataCompareSyncPlan,
  executeBatch: mocks.executeBatch,
  prepareDataCompareFromTables: mocks.prepareDataCompareFromTables,
  prepareDataCompareMissingTarget: mocks.prepareDataCompareMissingTarget,
}));

const mountedApps: App[] = [];

async function flushAsyncSetup() {
  for (let index = 0; index < 12; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  sessionMocks.session = null;
  vi.clearAllMocks();
});

function mountDialog(props: Record<string, unknown>): App {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(DataCompareDialog, { open: true, ...props }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  return app;
}

/** The dialog prefills only the source side; the target must be selected for a task to match. */
async function selectMatchedTarget(): Promise<void> {
  const targetConnectionTrigger = document.querySelectorAll<HTMLButtonElement>("button.dbx-diff-connection-trigger")[1];
  targetConnectionTrigger?.click();
  await flushAsyncSetup();
  document.querySelector<HTMLButtonElement>(`[data-picker-connection="${TARGET_CONNECTION_ID}"]`)?.click();
  await flushAsyncSetup();

  const targetDatabaseTrigger = document.querySelectorAll<HTMLButtonElement>("button.dbx-searchable-select-trigger")[2];
  targetDatabaseTrigger?.click();
  await flushAsyncSetup();
  const reporting = [...document.querySelectorAll<HTMLButtonElement>(".dbx-searchable-select-list button")].find((button) => button.textContent?.trim() === "REPORTING");
  reporting?.click();
  await flushAsyncSetup();
}

async function openWithPrefilledSource(table: string, options: { matchedTarget?: boolean } = {}) {
  mountDialog({ prefillConnectionId: SOURCE_CONNECTION_ID, prefillDatabase: "DBX_TEST", prefillSchema: "DBX_TEST", prefillTable: table });
  await flushAsyncSetup();
  if (options.matchedTarget !== false) await selectMatchedTarget();
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text)) ?? undefined;
}

function compareButton(): HTMLButtonElement | undefined {
  return buttonWithText(i18n.global.t("dataCompare.compare"));
}

function tableSelectionRow(table: string): HTMLButtonElement | undefined {
  return document.querySelector<HTMLButtonElement>(`[data-table-name="${table}"]`) ?? undefined;
}

function keyColumnRow(table: string): HTMLButtonElement | undefined {
  return document.querySelector<HTMLButtonElement>(`button.dbx-compare-key-table-row[data-key-column-table="${table}"]`) ?? undefined;
}

/** The global (or single-table) ignore picker lives in the ignored-columns section. */
function ignoreTrigger(): HTMLButtonElement | undefined {
  return document.querySelector<HTMLButtonElement>("[data-ignored-columns-section] button.dbx-compare-key-columns-trigger") ?? undefined;
}

async function closeAnyOpenPicker(): Promise<void> {
  if (!document.querySelector(".dbx-compare-key-columns-list")) return;
  document.body.click();
  await flushAsyncSetup();
  if (document.querySelector(".dbx-compare-key-columns-list")) {
    // Outside click can be swallowed in happy-dom: escape via the search input,
    // then fall back to toggling the trigger that still reports expanded.
    const popover = document.querySelector(".dbx-compare-key-columns-list")?.closest(".bg-popover");
    popover?.querySelector("input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushAsyncSetup();
  }
  if (document.querySelector(".dbx-compare-key-columns-list")) {
    document.querySelector<HTMLButtonElement>("button.dbx-compare-key-columns-trigger[aria-expanded='true']")?.click();
    await flushAsyncSetup();
  }
}

async function toggleColumnInPicker(trigger: HTMLButtonElement | undefined, columnName: string): Promise<void> {
  expect(trigger).toBeDefined();
  await closeAnyOpenPicker();
  trigger?.click();
  await flushAsyncSetup();
  const option = document.querySelector<HTMLButtonElement>(`.dbx-compare-key-columns-list button[data-column-name="${columnName}"]`);
  expect(option).toBeDefined();
  option?.click();
  await flushAsyncSetup();
  await closeAnyOpenPicker();
}

function ignoredColumnsOf(call: number): string[] {
  return (mocks.prepareDataCompareFromTables.mock.calls[call]?.[0] as { ignoredColumns?: string[] })?.ignoredColumns ?? [];
}

function preparationFor(table: string) {
  return {
    result: { added: [], removed: [], modified: [] },
    syncStatements: [`INSERT INTO ${table} (ID) VALUES (1)`],
    syncSql: `INSERT INTO ${table} (ID) VALUES (1)`,
    preSyncStatements: [],
    sourceRowCount: 1,
    targetRowCount: 0,
    sourceTruncated: false,
    targetTruncated: false,
    rowBudget: 100_000,
    syncEligible: true,
  };
}

function tableResult(sourceTable: string, columns: string[], ignoredOnlyCount: number): DataCompareTableResult {
  return {
    sourceTable,
    targetTable: sourceTable,
    keyColumns: [sourceTable === "EVENTS" ? "ID" : "NOTE_ID"],
    columns,
    columnInfo: [],
    status: "same",
    added: 0,
    removed: 0,
    modified: 0,
    ignoredOnlyCount,
    sourceRowCount: 5,
    targetRowCount: 5,
    sourceTruncated: false,
    targetTruncated: false,
    rowBudget: 100_000,
    syncEligible: true,
    databaseType: "oracle",
    selection: { added: createDataCompareSelection(true), removed: createDataCompareSelection(true), modified: createDataCompareSelection(true) },
    diff: { added: [], removed: [], modified: [], ignoredOnlyCount },
    expanded: false,
    showAll: { added: false, removed: false, modified: false },
  };
}

function configuredSession(): DataCompareSession {
  return {
    id: "compare-session",
    version: 1,
    status: "completed",
    config: {
      sourceConnectionId: SOURCE_CONNECTION_ID,
      sourceDatabase: "DBX_TEST",
      sourceSchema: "DBX_TEST",
      sourceDatabases: ["DBX_TEST"],
      sourceSchemas: ["DBX_TEST"],
      sourceTables: TABLE_NAMES,
      selectedSourceTables: ["EVENTS", "NOTES"],
      targetConnectionId: TARGET_CONNECTION_ID,
      targetDatabase: "REPORTING",
      targetSchema: "DBX_TEST",
      targetDatabases: ["REPORTING"],
      targetSchemas: ["DBX_TEST"],
      targetTables: TABLE_NAMES,
      targetTable: "",
      keyColumnsByTable: {},
      globalIgnoredColumns: ["UPDATED_AT", "GMT_CREATE"],
      ignoredColumnsByTable: { NOTES: ["BODY"] },
      label: "Oracle source → Oracle target",
    },
    progress: null,
    batchResults: [tableResult("EVENTS", ["ID", "TITLE", "CREATED_AT", "UPDATED_AT", "UPDATED_BY"], 3), tableResult("NOTES", ["NOTE_ID", "BODY"], 0)],
    syncPlan: { insertCount: 0, updateCount: 0, deleteCount: 0, statementCount: 0, syncStatements: [], syncSql: "" },
    error: null,
    startedAt: 1,
    finishedAt: 2,
  };
}

function setupMocks() {
  mocks.listSchemas.mockResolvedValue(["DBX_TEST", "REPORTING", "SYS"]);
  mocks.listTables.mockResolvedValue(TABLE_NAMES.map((name) => ({ name, table_type: "TABLE" })));
  mocks.getColumns.mockImplementation((connectionId: string, _database: string, _schema: string, table: string) => {
    const entry = TABLES[table];
    if (!entry) return Promise.resolve([]);
    return Promise.resolve(connectionId === SOURCE_CONNECTION_ID ? entry.source : entry.target);
  });
  mocks.prepareDataCompareFromTables.mockImplementation((options: { targetTable: string }) => Promise.resolve(preparationFor(options.targetTable)));
  mocks.prepareDataCompareMissingTarget.mockImplementation((options: { sourceTable: string }) => Promise.resolve(preparationFor(options.sourceTable)));
  mocks.buildDataCompareSyncPlan.mockResolvedValue({ insertCount: 0, updateCount: 0, deleteCount: 0, statementCount: 0, syncStatements: [], syncSql: "" });
}

describe("DataCompareDialog ignored columns", () => {
  it("fills the ignore list from audit columns with the shortcut and sends it to the compare", async () => {
    setupMocks();
    await openWithPrefilledSource("EVENTS");

    expect(ignoreTrigger()?.textContent?.trim()).toBe(i18n.global.t("dataCompare.ignoredColumnsSelectPlaceholder"));

    buttonWithText(i18n.global.t("dataCompare.ignoreAuditColumns"))?.click();
    await flushAsyncSetup();

    expect(ignoreTrigger()?.textContent?.trim()).toBe("CREATED_AT, UPDATED_AT, UPDATED_BY");

    compareButton()?.click();
    await flushAsyncSetup();

    expect(ignoredColumnsOf(0)).toEqual(["CREATED_AT", "UPDATED_AT", "UPDATED_BY"]);
  });

  it("keeps match columns unpickable in the ignore list", async () => {
    setupMocks();
    await openWithPrefilledSource("EVENTS");

    ignoreTrigger()?.click();
    await flushAsyncSetup();

    const keyOption = document.querySelector<HTMLButtonElement>(`.dbx-compare-key-columns-list button[data-column-name="ID"]`);
    expect(keyOption?.disabled).toBe(true);

    keyOption?.click();
    await flushAsyncSetup();

    expect(ignoreTrigger()?.textContent?.trim()).toBe(i18n.global.t("dataCompare.ignoredColumnsSelectPlaceholder"));
  });

  it("applies the global list to every table and merges per-table additions in a batch compare", async () => {
    setupMocks();
    await openWithPrefilledSource("EVENTS");

    tableSelectionRow("NOTES")?.click();
    await flushAsyncSetup();

    // Global: UPDATED_AT only exists on EVENTS; NOTE_ID is NOTES' match column and must not survive there.
    await toggleColumnInPicker(ignoreTrigger(), "UPDATED_AT");
    await toggleColumnInPicker(ignoreTrigger(), "NOTE_ID");

    // Per-table addition on NOTES, via the picker inside its expanded match-column row.
    keyColumnRow("NOTES")?.click();
    await flushAsyncSetup();
    const expandedPanel = keyColumnRow("NOTES")?.nextElementSibling;
    const perTableIgnoreTrigger = expandedPanel?.querySelectorAll<HTMLButtonElement>("button.dbx-compare-key-columns-trigger")[1];
    await toggleColumnInPicker(perTableIgnoreTrigger, "BODY");

    compareButton()?.click();
    await flushAsyncSetup();

    expect(ignoredColumnsOf(0)).toEqual(["UPDATED_AT"]);
    expect(ignoredColumnsOf(1)).toEqual(["BODY"]);
  });

  it("counts ignored-only rows in the summary and warns about ignored names no compared table has", async () => {
    setupMocks();
    sessionMocks.session = configuredSession();
    mountDialog({ sessionId: "compare-session" });
    await flushAsyncSetup();

    // EVENTS contributes 3 ignored-only rows; GMT_CREATE exists on no compared
    // intersection, so the dialog must flag it instead of silently ignoring nothing.
    expect(document.querySelector("[data-ignored-only-summary]")?.textContent).toContain(i18n.global.t("dataCompare.ignoredOnlySummary", { count: 3 }));
    expect(document.querySelector("[data-ignored-columns-warning]")?.textContent).toContain("GMT_CREATE");
    expect(document.querySelector("[data-ignored-columns-warning]")?.textContent).not.toContain("UPDATED_AT");
  });

  it("restores the ignored columns of a reopened session", async () => {
    setupMocks();
    sessionMocks.session = configuredSession();
    mountDialog({ sessionId: "compare-session" });
    await flushAsyncSetup();

    expect(ignoreTrigger()?.textContent?.trim()).toContain("UPDATED_AT");

    keyColumnRow("NOTES")?.click();
    await flushAsyncSetup();
    const expandedPanel = keyColumnRow("NOTES")?.nextElementSibling;
    const perTableIgnoreTrigger = expandedPanel?.querySelectorAll<HTMLButtonElement>("button.dbx-compare-key-columns-trigger")[1];
    expect(perTableIgnoreTrigger?.textContent?.trim()).toContain("BODY");
  });
});
