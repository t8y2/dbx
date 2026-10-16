// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataCompareDialog from "@/components/diff/DataCompareDialog.vue";
import type { DataCompareSession } from "@/composables/useDataCompareSession";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn().mockResolvedValue(["DBX_TEST", "REPORTING", "SYS"]),
  listTables: vi.fn().mockResolvedValue([{ name: "ORDERS", table_type: "TABLE" }]),
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

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

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
        rowBudget: 100_000,
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

const mountedApps: App[] = [];

async function flushAsyncSetup() {
  for (let index = 0; index < 8; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mountSessionDialog(pinia = createPinia()): App {
  sessionMocks.session = completedSession();
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(DataCompareDialog, { open: true, sessionId: sessionMocks.session!.id }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.use(pinia);
  app.mount(container);
  return app;
}

function buttonFor(key: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === i18n.global.t(key));
  if (!button) throw new Error(`Missing button: ${key}`);
  return button;
}

/** The header open-in-tab action is icon-only; locate it by its tooltip title (which swaps to the lock hint). */
function openInTabButton(): HTMLButtonElement {
  const titles = [i18n.global.t("dataCompare.openInTab"), i18n.global.t("dataCompare.transactionActiveHint")];
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => titles.includes(button.title));
  if (!button) throw new Error(`Missing open-in-tab icon button (titles: ${titles.join(" / ")})`);
  return button;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  sessionMocks.session = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("DataCompareDialog open in tab", () => {
  it("converts the dialog state into a data-compare tab with the snapshot", async () => {
    installLocalStorage();
    const pinia = createPinia();
    setActivePinia(pinia);
    mountSessionDialog(pinia);
    await flushAsyncSetup();

    expect(openInTabButton().disabled).toBe(false);
    openInTabButton().click();
    await flushAsyncSetup();

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    expect(store.tabs).toHaveLength(1);
    const tab = store.tabs[0]!;
    expect(tab.mode).toBe("data-compare");
    expect(tab.connectionId).toBe("oracle-11g");
    expect(tab.dataCompareState?.config.sourceConnectionId).toBe("oracle-11g");
    expect(tab.dataCompareState?.config.targetConnectionId).toBe("oracle-jdbc-11g");
    expect(tab.dataCompareState?.results).toHaveLength(1);
    expect(tab.dataCompareState?.syncPlan?.statementCount).toBe(2);
    expect(tab.title).toContain("Oracle");
  }, 30_000);

  it("keeps the open-in-tab action disabled while a manual transaction is pending", async () => {
    installLocalStorage();
    setActivePinia(createPinia());
    mountSessionDialog();
    await flushAsyncSetup();

    const label = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes(i18n.global.t("toolbar.manualTransaction")));
    const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeDefined();
    checkbox!.click();
    await nextTick();
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("dataCompare.pendingTransaction")));

    const iconButton = openInTabButton();
    expect(iconButton.disabled).toBe(true);
    expect(iconButton.title).toBe(i18n.global.t("dataCompare.transactionActiveHint"));
  }, 30_000);
});
