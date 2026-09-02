// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataCompareDialog from "@/components/diff/DataCompareDialog.vue";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn().mockResolvedValue(["DBX_TEST", "REPORTING", "SYS"]),
  listTables: vi.fn().mockResolvedValue([{ name: "CODEX_7467_META", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_primary_key: true }]),
}));

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
  vi.clearAllMocks();
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
