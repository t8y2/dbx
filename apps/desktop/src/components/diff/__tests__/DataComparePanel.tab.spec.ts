// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataComparePanel from "@/components/diff/DataComparePanel.vue";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listTables: vi.fn().mockResolvedValue([{ name: "ORDERS", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_primary_key: true }]),
  listForeignKeys: vi.fn().mockResolvedValue([]),
  buildDataCompareSyncPlan: vi.fn(),
  executeBatch: vi.fn(),
  beginManualTransaction: vi.fn().mockResolvedValue("compare-txn"),
  executeInManualTransaction: vi.fn().mockResolvedValue([]),
  commitManualTransaction: vi.fn().mockResolvedValue({}),
  rollbackManualTransaction: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [
      { id: "oracle-11g", name: "Oracle XE 11g", db_type: "oracle", driver_profile: "oracle" },
      { id: "oracle-jdbc-11g", name: "Oracle JDBC 11g", db_type: "jdbc", driver_profile: "oracle" },
    ],
    sidebarLayout: { groups: [], order: [] },
    getConfig: (id: string) => (id === "oracle-11g" || id === "oracle-jdbc-11g" ? { id, name: id, db_type: id.includes("jdbc") ? "jdbc" : "oracle", driver_profile: "oracle" } : undefined),
    ensureConnected: mocks.ensureConnected,
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  listForeignKeys: mocks.listForeignKeys,
  buildDataCompareSyncPlan: mocks.buildDataCompareSyncPlan,
  executeBatch: mocks.executeBatch,
  beginManualTransaction: mocks.beginManualTransaction,
  executeInManualTransaction: mocks.executeInManualTransaction,
  commitManualTransaction: mocks.commitManualTransaction,
  rollbackManualTransaction: mocks.rollbackManualTransaction,
}));

function tabSnapshot() {
  return {
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
      keyColumnsByTable: {},
      label: "src -> tgt",
    },
    results: [
      {
        sourceTable: "ORDERS",
        targetTable: "ORDERS",
        keyColumns: ["ID"],
        columns: ["ID"],
        columnInfo: [],
        status: "different",
        added: 1,
        removed: 0,
        modified: 0,
        sourceRowCount: 1,
        targetRowCount: 0,
        sourceTruncated: false,
        targetTruncated: false,
        rowBudget: 100_000,
        diff: { added: [], removed: [], modified: [] },
        expanded: true,
        showAll: { added: true, removed: true, modified: true },
      },
    ],
    syncPlan: { insertCount: 1, updateCount: 0, deleteCount: 0, statementCount: 1, syncStatements: ["INSERT 1"], syncSql: "INSERT 1;" },
  };
}

const mountedApps: App[] = [];
const emitted: Record<string, unknown[]> = {};

async function flushAsyncSetup() {
  for (let index = 0; index < 8; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mountTabPanel() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(DataComparePanel, {
            inDialog: false,
            tabId: "tab-1",
            initialState: tabSnapshot(),
            onTransactionSessionChange: (sessionId: unknown) => (emitted["transaction-session-change"] = [sessionId]),
          });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.use(createPinia());
  app.mount(container);
  return app;
}

function buttonFor(key: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === i18n.global.t(key));
  if (!button) throw new Error(`Missing button: ${key}`);
  return button;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
  for (const key of Object.keys(emitted)) delete emitted[key];
});

describe("DataComparePanel tab form factor", () => {
  it("mirrors the manual transaction session onto the tab while it is pending", async () => {
    mountTabPanel();
    await flushAsyncSetup();

    const label = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes(i18n.global.t("toolbar.manualTransaction")));
    const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeDefined();
    checkbox!.click();
    await nextTick();
    buttonFor("diff.executeSync").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("dataCompare.pendingTransaction")));

    expect(mocks.beginManualTransaction).toHaveBeenCalled();
    expect(emitted["transaction-session-change"]).toEqual(["compare-txn"]);
    // The in-panel convert action is gone (the tab pill owns conversion now);
    // the transaction guard itself lives on the tab bar and stays tested there.
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("dataCompare.convertToDialog")))).toBe(false);
  }, 30_000);
});
