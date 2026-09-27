// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataCompareDialog from "@/components/diff/DataCompareDialog.vue";
import type { DataCompareSession } from "@/composables/useDataCompareSession";

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
  USERS: {
    source: [column("USER_ID", true), column("EMAIL"), column("NAME")],
    target: [column("USER_ID", true), column("EMAIL"), column("NAME")],
  },
  ORDERS: {
    source: [column("TENANT_ID", true), column("ORDER_ID", true), column("ORDER_NO"), column("AMOUNT")],
    target: [column("TENANT_ID", true), column("ORDER_ID", true), column("ORDER_NO"), column("AMOUNT")],
  },
  PAYMENTS: {
    source: [column("TENANT_ID"), column("PAYMENT_NO")],
    target: [column("TENANT_ID"), column("PAYMENT_NO")],
  },
  CASES: {
    source: [column("snid", true), column("username")],
    target: [column("SNID", true), column("USERNAME")],
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

function keyColumnTrigger(): HTMLButtonElement | undefined {
  return document.querySelector<HTMLButtonElement>("button.dbx-compare-key-columns-trigger") ?? undefined;
}

function keyColumnHint(): string {
  return document.querySelector<HTMLElement>("[data-key-column-hint]")?.textContent?.trim() ?? "";
}

function keyColumnRow(table: string): HTMLButtonElement | undefined {
  return document.querySelector<HTMLButtonElement>(`button.dbx-compare-key-table-row[data-key-column-table="${table}"]`) ?? undefined;
}

function tableSelectionRow(table: string): HTMLButtonElement | undefined {
  return document.querySelector<HTMLButtonElement>(`[data-table-name="${table}"]`) ?? undefined;
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text)) ?? undefined;
}

function compareButton(): HTMLButtonElement | undefined {
  return buttonWithText(i18n.global.t("dataCompare.compare"));
}

async function togglePickerColumn(columnName: string): Promise<void> {
  // The popover stays open between toggles, so only open it when it is closed.
  if (!document.querySelector(".dbx-compare-key-columns-list")) {
    keyColumnTrigger()?.click();
    await flushAsyncSetup();
  }
  const option = document.querySelector<HTMLButtonElement>(`.dbx-compare-key-columns-list button[data-column-name="${columnName}"]`);
  expect(option).toBeDefined();
  option?.click();
  await flushAsyncSetup();
}

function comparedKeyColumns(): { table: string; keys: string[] }[] {
  return mocks.prepareDataCompareFromTables.mock.calls.map((call) => ({
    table: (call[0] as { targetTable: string }).targetTable,
    keys: (call[0] as { keyColumns: string[] }).keyColumns,
  }));
}

function preparationFor(table: string) {
  return {
    result: { added: [{ key: "1", keyValues: { USER_ID: 1 }, values: { USER_ID: 1, EMAIL: "a@b.c" } }], removed: [], modified: [] },
    syncStatements: [`INSERT INTO ${table} (USER_ID) VALUES (1)`],
    syncSql: `INSERT INTO ${table} (USER_ID) VALUES (1)`,
    preSyncStatements: [],
    sourceRowCount: 1,
    targetRowCount: 0,
    sourceTruncated: false,
    targetTruncated: false,
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
      selectedSourceTables: ["USERS", "ORDERS"],
      targetConnectionId: TARGET_CONNECTION_ID,
      targetDatabase: "REPORTING",
      targetSchema: "DBX_TEST",
      targetDatabases: ["REPORTING"],
      targetSchemas: ["DBX_TEST"],
      targetTables: TABLE_NAMES,
      targetTable: "",
      keyColumnsByTable: { ORDERS: ["ORDER_NO"] },
      label: "Oracle source → Oracle target",
    },
    progress: null,
    batchResults: [],
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
  mocks.buildDataCompareSyncPlan.mockResolvedValue({ insertCount: 1, updateCount: 0, deleteCount: 0, statementCount: 1, syncStatements: ["INSERT"], syncSql: "INSERT" });
}

describe("DataCompareDialog match columns", () => {
  it("auto-selects the single primary key of a single-table compare and labels it", async () => {
    setupMocks();
    await openWithPrefilledSource("USERS");

    expect(keyColumnTrigger()?.textContent?.trim()).toBe("USER_ID");
    expect(keyColumnHint()).toBe(i18n.global.t("dataCompare.keyColumnsAutoSummary", { columns: "USER_ID" }));
    expect(document.body.textContent).toContain(i18n.global.t("dataCompare.keyColumnsStatusAuto"));
    expect(compareButton()?.disabled).toBe(false);
  });

  it("keeps the declared order of a composite primary key", async () => {
    setupMocks();
    await openWithPrefilledSource("ORDERS");

    expect(keyColumnTrigger()?.textContent?.trim()).toBe("TENANT_ID, ORDER_ID");
    expect(keyColumnHint()).toBe(i18n.global.t("dataCompare.keyColumnsAutoSummary", { columns: "TENANT_ID, ORDER_ID" }));
  });

  it("offers the real database columns with a primary-key badge", async () => {
    setupMocks();
    await openWithPrefilledSource("ORDERS");

    keyColumnTrigger()?.click();
    await flushAsyncSetup();

    const options = [...document.querySelectorAll<HTMLButtonElement>(".dbx-compare-key-columns-list button")];
    expect(options.map((option) => option.dataset.columnName)).toEqual(["TENANT_ID", "ORDER_ID", "ORDER_NO", "AMOUNT"]);
    expect(options.map((option) => option.dataset.primaryKey)).toEqual(["true", "true", "false", "false"]);
    expect(document.body.textContent).toContain(i18n.global.t("dataCompare.keyColumnsSelectedCount", { selected: 2, total: 4 }));
  });

  it("requires an explicit selection when the table has no primary key", async () => {
    setupMocks();
    await openWithPrefilledSource("PAYMENTS");

    expect(keyColumnTrigger()?.textContent?.trim()).toBe(i18n.global.t("dataCompare.keyColumnsSelectPlaceholder"));
    expect(keyColumnHint()).toBe(i18n.global.t("dataCompare.keyColumnsNoPrimaryKey"));
    expect(compareButton()?.disabled).toBe(true);

    await togglePickerColumn("TENANT_ID");

    expect(keyColumnTrigger()?.textContent?.trim()).toBe("TENANT_ID");
    expect(compareButton()?.disabled).toBe(false);
    expect(document.body.textContent).toContain(i18n.global.t("dataCompare.keyColumnsStatusManual"));
  });

  it("lets the user override the inferred primary key and reset back to it", async () => {
    setupMocks();
    await openWithPrefilledSource("ORDERS");

    await togglePickerColumn("TENANT_ID");
    await togglePickerColumn("ORDER_ID");
    await togglePickerColumn("ORDER_NO");

    expect(keyColumnTrigger()?.textContent?.trim()).toBe("ORDER_NO");
    expect(keyColumnHint()).toBe(i18n.global.t("dataCompare.keyColumnsManualHint", { columns: "ORDER_NO" }));

    buttonWithText(i18n.global.t("dataCompare.keyColumnsResetAuto"))?.click();
    await flushAsyncSetup();

    expect(keyColumnTrigger()?.textContent?.trim()).toBe("TENANT_ID, ORDER_ID");
  });

  it("configures match columns per table in a batch compare", async () => {
    setupMocks();
    await openWithPrefilledSource("USERS");

    tableSelectionRow("ORDERS")?.click();
    await flushAsyncSetup();

    expect(keyColumnRow("USERS")?.textContent).toContain("USER_ID");
    expect(keyColumnRow("ORDERS")?.textContent).toContain("TENANT_ID, ORDER_ID");
    expect(keyColumnRow("USERS")?.textContent).toContain(i18n.global.t("dataCompare.keyColumnsStatusAuto"));
    expect(keyColumnRow("ORDERS")?.textContent).toContain(i18n.global.t("dataCompare.keyColumnsStatusAuto"));

    keyColumnRow("ORDERS")?.click();
    await flushAsyncSetup();
    await togglePickerColumn("TENANT_ID");
    await togglePickerColumn("ORDER_ID");
    await togglePickerColumn("ORDER_NO");

    expect(keyColumnRow("ORDERS")?.textContent).toContain("ORDER_NO");
    expect(keyColumnRow("ORDERS")?.textContent).toContain(i18n.global.t("dataCompare.keyColumnsStatusManual"));
    // The other table must keep its own primary key.
    expect(keyColumnRow("USERS")?.textContent).toContain("USER_ID");
    expect(keyColumnRow("USERS")?.textContent).toContain(i18n.global.t("dataCompare.keyColumnsStatusAuto"));

    compareButton()?.click();
    await flushAsyncSetup();

    expect(comparedKeyColumns()).toEqual([
      { table: "USERS", keys: ["USER_ID"] },
      { table: "ORDERS", keys: ["ORDER_NO"] },
    ]);
  });

  it("restores per-table match columns when a session is reopened", async () => {
    setupMocks();
    sessionMocks.session = configuredSession();
    mountDialog({ sessionId: "compare-session" });
    await flushAsyncSetup();

    expect(keyColumnRow("USERS")?.textContent).toContain("USER_ID");
    expect(keyColumnRow("USERS")?.textContent).toContain(i18n.global.t("dataCompare.keyColumnsStatusAuto"));
    expect(keyColumnRow("ORDERS")?.textContent).toContain("ORDER_NO");
    expect(keyColumnRow("ORDERS")?.textContent).toContain(i18n.global.t("dataCompare.keyColumnsStatusManual"));
  });

  it("drops a stale manual selection after switching to another source table", async () => {
    setupMocks();
    await openWithPrefilledSource("USERS");

    await togglePickerColumn("EMAIL");
    expect(keyColumnTrigger()?.textContent?.trim()).toBe("USER_ID, EMAIL");
    expect(document.body.textContent).toContain(i18n.global.t("dataCompare.keyColumnsStatusManual"));

    tableSelectionRow("USERS")?.click();
    await flushAsyncSetup();
    tableSelectionRow("ORDERS")?.click();
    await flushAsyncSetup();

    expect(keyColumnTrigger()?.textContent?.trim()).toBe("TENANT_ID, ORDER_ID");
    expect(keyColumnHint()).toBe(i18n.global.t("dataCompare.keyColumnsAutoSummary", { columns: "TENANT_ID, ORDER_ID" }));
  });

  it("sends the source spelling of a match column whose target column differs in case", async () => {
    setupMocks();
    await openWithPrefilledSource("CASES");

    expect(keyColumnTrigger()?.textContent?.trim()).toBe("snid");
    expect(compareButton()?.disabled).toBe(false);

    compareButton()?.click();
    await flushAsyncSetup();

    const options = mocks.prepareDataCompareFromTables.mock.calls[0]?.[0] as { keyColumns: string[]; columns: string[]; sourceColumns: string[]; sourceTable: string };
    expect(options.sourceTable).toBe("CASES");
    expect(options.keyColumns).toEqual(["SNID"]);
    expect(options.columns).toEqual(["SNID", "USERNAME"]);
    expect(options.sourceColumns).toEqual(["snid", "username"]);
    expect(document.body.textContent).not.toContain(i18n.global.t("dataCompare.missingKeyColumns", { columns: "snid" }));
  });
});
