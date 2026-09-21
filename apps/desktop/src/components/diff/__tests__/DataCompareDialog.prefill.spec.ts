// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataCompareDialog from "@/components/diff/DataCompareDialog.vue";
import type { DataCompareSession } from "@/composables/useDataCompareSession";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn().mockResolvedValue(["DBX_TEST", "REPORTING", "SYS"]),
  listTables: vi.fn().mockResolvedValue([{ name: "CODEX_7467_META", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_primary_key: true }]),
  buildDataCompareSyncPlan: vi.fn(),
  executeBatch: vi.fn(),
  beginManualTransaction: vi.fn().mockResolvedValue("compare-txn"),
  executeInManualTransaction: vi.fn().mockResolvedValue([]),
  commitManualTransaction: vi.fn().mockResolvedValue({}),
  rollbackManualTransaction: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

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
  beginManualTransaction: mocks.beginManualTransaction,
  executeInManualTransaction: mocks.executeInManualTransaction,
  commitManualTransaction: mocks.commitManualTransaction,
  rollbackManualTransaction: mocks.rollbackManualTransaction,
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
  vi.unstubAllGlobals();
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

function buttonFor(key: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === i18n.global.t(key));
  if (!button) throw new Error(`Missing button: ${key}`);
  return button;
}

async function mountManualSession(session = completedSession()) {
  const app = mountSessionDialog(session);
  await flushAsyncSetup();
  const label = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes(i18n.global.t("toolbar.manualTransaction")));
  const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox).toBeDefined();
  checkbox!.click();
  await nextTick();
  return app;
}

describe("DataCompareDialog manual transactions", () => {
  it("keeps the target session pending until commit and locks target changes", async () => {
    const session = completedSession();
    await mountManualSession(session);
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("dataCompare.pendingTransaction")));
    expect(mocks.beginManualTransaction).toHaveBeenCalledWith("oracle-jdbc-11g", "REPORTING", "DBX_TEST");
    expect(mocks.executeInManualTransaction).toHaveBeenCalledWith("compare-txn", "INSERT 1;\nINSERT 2", "REPORTING", "DBX_TEST");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(mocks.commitManualTransaction).not.toHaveBeenCalled();
    expect(buttonFor("dataCompare.recompare").disabled).toBe(true);
    expect([...document.querySelectorAll<HTMLButtonElement>("button.dbx-searchable-select-trigger")].every((button) => button.disabled)).toBe(true);
    buttonFor("toolbar.commit").click();
    await vi.waitFor(() => expect(mocks.commitManualTransaction).toHaveBeenCalledWith("compare-txn"));
    await flushAsyncSetup();
    expect(document.body.textContent).not.toContain(i18n.global.t("dataCompare.pendingTransaction"));
    expect(session.syncPlan.syncStatements).toEqual([]);
    expect(session.batchResults).toEqual([]);
  });

  it("rolls back without committing", async () => {
    await mountManualSession();
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("dataCompare.pendingTransaction")));
    buttonFor("toolbar.rollback").click();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("compare-txn"));
    expect(mocks.commitManualTransaction).not.toHaveBeenCalled();
  });

  it("stops on the first failed batch without ordinary retries or later batches", async () => {
    const session = completedSession();
    session.syncPlan.syncStatements = Array.from({ length: 501 }, (_, index) => `INSERT ${index}`);
    session.syncPlan.statementCount = 501;
    mocks.executeInManualTransaction.mockRejectedValueOnce(new Error("transaction statement rejected"));
    await mountManualSession(session);
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("compare-txn"));
    expect(mocks.executeInManualTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(mocks.commitManualTransaction).not.toHaveBeenCalled();
  });

  it("cleans up a transaction created after the dialog unmounts", async () => {
    let resolveBegin!: (id: string) => void;
    mocks.beginManualTransaction.mockReturnValueOnce(new Promise((resolve) => (resolveBegin = resolve)));
    const app = await mountManualSession();
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(mocks.beginManualTransaction).toHaveBeenCalled());
    mountedApps.splice(mountedApps.indexOf(app), 1);
    app.unmount();
    resolveBegin("late-compare-txn");
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("late-compare-txn"));
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
  });

  it("keeps a rollback control when commit fails", async () => {
    mocks.commitManualTransaction.mockRejectedValueOnce(new Error("commit unavailable"));
    await mountManualSession();
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("dataCompare.pendingTransaction")));
    buttonFor("toolbar.commit").click();
    await vi.waitFor(() => expect(mocks.commitManualTransaction).toHaveBeenCalled());
    await flushAsyncSetup();
    expect(buttonFor("toolbar.rollback").disabled).toBe(false);
    expect(document.body.textContent).toContain(i18n.global.t("dataCompare.pendingTransaction"));
  });

  it("waits for an active batch before rollback on unmount and skips later batches", async () => {
    const session = completedSession();
    session.syncPlan.syncStatements = Array.from({ length: 501 }, (_, index) => `INSERT ${index}`);
    session.syncPlan.statementCount = 501;
    let finish!: (rows: unknown[]) => void;
    mocks.executeInManualTransaction.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const app = await mountManualSession(session);
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(mocks.executeInManualTransaction).toHaveBeenCalledOnce());
    mountedApps.splice(mountedApps.indexOf(app), 1);
    app.unmount();
    expect(mocks.rollbackManualTransaction).not.toHaveBeenCalled();
    finish([]);
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("compare-txn"));
    expect(mocks.executeInManualTransaction).toHaveBeenCalledTimes(1);
  });

  it("invalidates the sync plan after an unknown commit result without claiming success", async () => {
    const session = completedSession();
    mocks.commitManualTransaction.mockRejectedValueOnce(new Error("response lost"));
    await mountManualSession(session);
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("dataCompare.pendingTransaction")));
    buttonFor("toolbar.commit").click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("response lost", 5000));
    expect(buttonFor("toolbar.commit").disabled).toBe(true);
    mocks.rollbackManualTransaction.mockRejectedValueOnce(new Error("Transaction session not found"));
    buttonFor("toolbar.rollback").click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(i18n.global.t("toolbar.commitOutcomeUnknown"), 5000));
    expect(session.syncPlan.syncStatements).toEqual([]);
    expect(session.batchResults).toEqual([]);
    expect(mocks.toast).not.toHaveBeenCalledWith(i18n.global.t("dataCompare.syncSuccess"), 2000);
  });

  it("disables commit when rollback after an execution error fails", async () => {
    mocks.executeInManualTransaction.mockRejectedValueOnce(new Error("statement failed"));
    mocks.rollbackManualTransaction.mockRejectedValueOnce(new Error("rollback unavailable"));
    await mountManualSession();
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalled());
    await flushAsyncSetup();
    expect(buttonFor("toolbar.commit").disabled).toBe(true);
    expect(buttonFor("toolbar.rollback").disabled).toBe(false);
  });

  it("requires rollback confirmation before closing a pending transaction", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    await mountManualSession();
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("dataCompare.pendingTransaction")));
    buttonFor("common.close").click();
    await flushAsyncSetup();
    expect(mocks.rollbackManualTransaction).not.toHaveBeenCalled();
    buttonFor("common.close").click();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("compare-txn"));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

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

  it("starts another comparison and distinguishes source and target panels after results", async () => {
    mountSessionDialog(completedSession());

    await flushAsyncSetup();

    const recompareButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(i18n.global.t("dataCompare.recompare")));
    expect(recompareButton).toBeDefined();
    expect([...document.querySelectorAll("div")].filter((element) => element.classList.contains("border-blue-500/35"))).toHaveLength(1);
    expect([...document.querySelectorAll("div")].filter((element) => element.classList.contains("border-emerald-500/35"))).toHaveLength(1);

    recompareButton?.click();
    await flushAsyncSetup();

    expect(mocks.ensureConnected).toHaveBeenCalledWith("oracle-11g");
    expect(mocks.ensureConnected).toHaveBeenCalledWith("oracle-jdbc-11g");
  });

  it("disables recompare while sync SQL is still executing against the target", async () => {
    mocks.executeBatch.mockImplementation(() => new Promise(() => {}));
    mountSessionDialog(completedSession());

    await flushAsyncSetup();
    mocks.ensureConnected.mockClear();

    const executeButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(i18n.global.t("diff.executeSync")));
    expect(executeButton).toBeDefined();
    executeButton?.click();
    await flushAsyncSetup();

    const recompareButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(i18n.global.t("dataCompare.recompare")));
    expect(recompareButton).toBeDefined();
    expect(recompareButton?.disabled).toBe(true);

    recompareButton?.click();
    await flushAsyncSetup();

    expect(mocks.ensureConnected).not.toHaveBeenCalledWith("oracle-11g");
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

describe("DataCompareDialog results layout", () => {
  it("scrolls results in a plain container so the footer cannot overlap them", async () => {
    // Chromium cannot scroll or clip a <fieldset> that owns `overflow-auto`
    // (see issue #9839), so the scroll region must be a plain element and the
    // fieldset may only stay in the tree as the disabled-state provider.
    mountSessionDialog(completedSession());
    await flushAsyncSetup();

    const fieldset = document.querySelector("fieldset");
    expect(fieldset).not.toBeNull();
    expect(fieldset?.className).not.toContain("overflow-auto");

    const scroller = fieldset?.parentElement;
    expect(scroller?.tagName).toBe("DIV");
    expect(scroller?.className).toContain("overflow-auto");
    expect(scroller?.className).toContain("min-h-0");

    const dialogFooter = document.querySelector('[data-slot="dialog-footer"]');
    expect(dialogFooter).not.toBeNull();
    expect(scroller?.contains(dialogFooter)).toBe(false);
  });
});
