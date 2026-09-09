// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataCompareDialog from "@/components/diff/DataCompareDialog.vue";
import type { DataCompareSession } from "@/composables/useDataCompareSession";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn().mockResolvedValue(["DBX_TEST", "REPORTING", "SYS"]),
  listTables: vi.fn().mockResolvedValue([{ name: "CODEX_7467_META", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_primary_key: true }]),
  buildDataCompareSyncPlan: vi.fn(),
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
}));

const mountedApps: App[] = [];

async function flushAsyncSetup() {
  for (let index = 0; index < 8; index += 1) {
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

function completedSession(): DataCompareSession {
  return {
    id: "compare-session",
    version: 1,
    status: "completed",
    config: {
      sourceConnectionId: "oracle-11g",
      sourceDatabase: "DBX_TEST",
      sourceSchema: "DBX_TEST",
      sourceDatabases: ["DBX_TEST"],
      sourceSchemas: ["DBX_TEST"],
      sourceTables: ["ORDERS"],
      selectedSourceTables: ["ORDERS"],
      targetConnectionId: "oracle-jdbc-11g",
      targetDatabase: "REPORTING",
      targetSchema: "DBX_TEST",
      targetDatabases: ["REPORTING"],
      targetSchemas: ["DBX_TEST"],
      targetTables: ["ORDERS"],
      targetTable: "ORDERS",
      keyColumns: ["ID"],
      label: "Oracle source → Oracle target",
    },
    progress: null,
    batchResults: [
      {
        sourceTable: "ORDERS",
        targetTable: "ORDERS",
        keyColumns: ["ID"],
        columns: ["ID", "NAME"],
        columnInfo: [],
        status: "different",
        added: 2,
        removed: 0,
        modified: 0,
        sourceRowCount: 2,
        targetRowCount: 0,
        sourceTruncated: false,
        targetTruncated: false,
        databaseType: "oracle",
        diff: {
          added: [
            { key: "1", keyValues: { ID: 1 }, values: { ID: 1, NAME: "first" }, selected: true },
            { key: "2", keyValues: { ID: 2 }, values: { ID: 2, NAME: "second" }, selected: true },
          ],
          removed: [],
          modified: [],
        },
        expanded: true,
        showAll: { added: true, removed: true, modified: true },
      },
    ],
    syncPlan: {
      insertCount: 2,
      updateCount: 0,
      deleteCount: 0,
      statementCount: 2,
      syncStatements: ["INSERT 1", "INSERT 2"],
      syncSql: "INSERT 1;\nINSERT 2;",
    },
    error: null,
    startedAt: 1,
    finishedAt: 2,
  };
}

function mountSessionDialog(session: DataCompareSession): App {
  sessionMocks.session = session;
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(DataCompareDialog, { open: true, sessionId: session.id }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  return app;
}

describe("DataCompareDialog source prefill", () => {
  it("keeps the Oracle source table after loading database and schema prefills", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h(DataCompareDialog, {
            open: true,
            prefillConnectionId: "oracle-11g",
            prefillDatabase: "DBX_TEST",
            prefillSchema: "DBX_TEST",
            prefillTable: "CODEX_7046_META",
          }),
      }),
    );
    mountedApps.push(app);
    app.use(i18n);
    app.mount(container);
    await flushAsyncSetup();

    expect(mocks.listDatabases).not.toHaveBeenCalled();
    expect(mocks.listSchemas).toHaveBeenCalledWith("oracle-11g", "XE", true);

    const searchableSelectTriggers = [...document.querySelectorAll<HTMLButtonElement>("button.dbx-searchable-select-trigger")];
    const sourceDatabaseTrigger = searchableSelectTriggers[0];
    expect(sourceDatabaseTrigger?.title).toBe("DBX_TEST");
    expect(sourceDatabaseTrigger?.disabled).toBe(false);
    sourceDatabaseTrigger?.click();
    await flushAsyncSetup();

    const databaseOptions = [...document.querySelectorAll<HTMLButtonElement>(".dbx-searchable-select-list button")].map((button) => button.textContent?.trim());
    expect(databaseOptions).toEqual(expect.arrayContaining(["DBX_TEST", "REPORTING"]));
    expect(mocks.listTables).toHaveBeenCalledWith("oracle-11g", "DBX_TEST", "DBX_TEST");
    expect(document.body.textContent).toContain("CODEX_7467_META");
    expect(document.body.textContent).not.toContain("暂无可比较的表");
  });

  it("loads schemas and tables after selecting an Oracle JDBC target connection", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h(DataCompareDialog, {
            open: true,
            prefillConnectionId: "oracle-11g",
            prefillDatabase: "DBX_TEST",
            prefillSchema: "DBX_TEST",
            prefillTable: "CODEX_7467_META",
          }),
      }),
    );
    mountedApps.push(app);
    app.use(i18n);
    app.mount(container);
    await flushAsyncSetup();

    const targetConnectionTrigger = document.querySelectorAll<HTMLButtonElement>("button.dbx-diff-connection-trigger")[1];
    expect(targetConnectionTrigger).toBeDefined();
    targetConnectionTrigger?.click();
    await flushAsyncSetup();

    const jdbcConnectionOption = document.querySelector<HTMLButtonElement>('[data-picker-connection="oracle-jdbc-11g"]');
    expect(jdbcConnectionOption).toBeDefined();
    jdbcConnectionOption?.click();
    await flushAsyncSetup();

    expect(mocks.listSchemas).toHaveBeenCalledWith("oracle-jdbc-11g", "", true);

    const triggersAfterTargetLoad = [...document.querySelectorAll<HTMLButtonElement>("button.dbx-searchable-select-trigger")];
    const targetDatabaseTrigger = triggersAfterTargetLoad[2];
    expect(targetDatabaseTrigger?.disabled).toBe(false);
    targetDatabaseTrigger?.click();
    await flushAsyncSetup();

    const targetDatabaseOptions = [...document.querySelectorAll<HTMLButtonElement>(".dbx-searchable-select-list button")].map((button) => button.textContent?.trim());
    expect(targetDatabaseOptions).toEqual(expect.arrayContaining(["DBX_TEST", "REPORTING"]));

    const reportingOption = [...document.querySelectorAll<HTMLButtonElement>(".dbx-searchable-select-list button")].find((button) => button.textContent?.trim() === "REPORTING");
    expect(reportingOption).toBeDefined();
    reportingOption?.click();
    await flushAsyncSetup();

    expect(mocks.listTables).toHaveBeenCalledWith("oracle-jdbc-11g", "REPORTING", "DBX_TEST");
    expect(document.body.textContent).toContain("CODEX_7467_META");
  });
});

describe("DataCompareDialog session restore", () => {
  it("keeps restored fields, results, and sync SQL after queued watchers flush", async () => {
    const session = completedSession();
    mountSessionDialog(session);

    await flushAsyncSetup();

    expect(mocks.listSchemas).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("ORDERS");
    expect(document.body.textContent).toContain("ID=1");
    expect(document.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value).toBe("INSERT 1;\nINSERT 2;");
  });

  it("persists the latest selection plan when the dialog closes during planning", async () => {
    const session = completedSession();
    let resolvePlan!: (plan: DataCompareSession["syncPlan"]) => void;
    mocks.buildDataCompareSyncPlan.mockReturnValueOnce(new Promise((resolve) => (resolvePlan = resolve)));
    const app = mountSessionDialog(session);
    await flushAsyncSetup();

    const firstRow = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("ID=1"));
    expect(firstRow).toBeDefined();
    firstRow?.click();
    await nextTick();
    expect(mocks.buildDataCompareSyncPlan).toHaveBeenCalledOnce();

    mountedApps.splice(mountedApps.indexOf(app), 1);
    app.unmount();
    resolvePlan({
      insertCount: 1,
      updateCount: 0,
      deleteCount: 0,
      statementCount: 1,
      syncStatements: ["INSERT 2"],
      syncSql: "INSERT 2;",
    });
    await flushAsyncSetup();

    expect(session.batchResults[0]?.diff.added[0]?.selected).toBe(false);
    expect(session.syncPlan.syncStatements).toEqual(["INSERT 2"]);
    expect(session.syncPlan.syncSql).toBe("INSERT 2;");
  });
});
