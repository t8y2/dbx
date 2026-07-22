import { computed, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiresDatabaseSelection, useSqlExecution } from "../useSqlExecution";
import { useConnectionStore } from "@/stores/connectionStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { ConnectionConfig, QueryTab } from "@/types/database";

vi.mock("vue-i18n", () => ({
  createI18n: () => ({ global: { locale: { value: "en" }, setLocaleMessage: vi.fn() } }),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  saveEditorSettings: vi.fn(),
  saveHistory: vi.fn(),
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function connection(dbType: ConnectionConfig["db_type"]): ConnectionConfig {
  return {
    id: "conn-1",
    name: "Local",
    db_type: dbType,
    host: "localhost",
    port: 3306,
    username: "root",
    password: "",
  };
}

function queryTab(database = ""): QueryTab {
  return {
    id: "tab-1",
    connectionId: "conn-1",
    database,
    schema: undefined,
    title: "SQL",
    sql: "",
    mode: "query",
    isDirty: false,
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
  };
}

describe("requiresDatabaseSelection", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("allows MySQL CREATE DATABASE to run without a selected database", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db")).toBe(false);
  });

  it("allows MySQL SHOW DATABASES to run without a selected database", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "SHOW DATABASES")).toBe(false);
  });

  it("allows MySQL SHOW VARIABLES without a selected database", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "SHOW VARIABLES LIKE 'version%'")).toBe(false);
  });

  it("allows MySQL CREATE SCHEMA with options to run without a selected database", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE SCHEMA `app-db` DEFAULT CHARACTER SET utf8mb4")).toBe(false);
  });

  it("allows MySQL install batches that switch databases before table DDL", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db; USE app_db; CREATE TABLE users(id INT PRIMARY KEY)")).toBe(false);
  });

  it("allows MySQL install batches with session setup before switching databases", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "SET NAMES utf8mb4; DROP DATABASE IF EXISTS app_db; CREATE DATABASE app_db; USE app_db; INSERT INTO users VALUES (1)")).toBe(false);
  });

  it("lets MySQL report statement-specific database requirements", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db; CREATE TABLE users(id INT)")).toBe(false);
  });

  it("lets MySQL reject malformed database switches", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db; USE app_db SELECT 1; CREATE TABLE users(id INT)")).toBe(false);
  });

  it.each(["SELECT 1", "SELECT VERSION()", "SELECT * FROM mysql.user", "SELECT * FROM users"])("allows connection-level MySQL query: %s", (sql) => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), sql)).toBe(false);
  });

  it("still requires a database for non-MySQL multi-database connections", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mssql"), "SELECT * FROM dbo.users")).toBe(true);
  });

  it("allows HANA with default database (empty string) to execute queries", () => {
    expect(requiresDatabaseSelection(queryTab(""), connection("saphana"), "SELECT * FROM MOMX_MES.Z_SHIPMENT_INFORMATION")).toBe(false);
  });

  it("allows JDBC with default database (empty string) to execute queries", () => {
    expect(requiresDatabaseSelection(queryTab(""), connection("jdbc"), "SELECT * FROM users")).toBe(false);
  });

  it("allows PostgreSQL with default database (empty string) to execute queries", () => {
    expect(requiresDatabaseSelection(queryTab(""), connection("postgres"), "SELECT * FROM public.users")).toBe(false);
  });
});

describe("useSqlExecution", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("passes the selected statement's editor offset to the query store", async () => {
    const fullSql = "SELECT * FROM users;\nSELECT * FROM users;";
    const selectionFrom = fullSql.lastIndexOf("SELECT");
    const selectedSql = fullSql.slice(selectionFrom, -1);
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql: fullSql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => selectedSql),
      resolveExecutableSql: async () => selectedSql,
      activeOutputView,
    });

    await execution.tryExecute({ fullSql, selectedSql, cursorPos: selectionFrom, selectionFrom, selectionTo: fullSql.length - 1 });

    expect(executeCurrentSql).toHaveBeenCalledWith(selectedSql, { sourceOffset: selectionFrom });
  });

  it("sends native SET variables without client-side expansion", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["ok"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(historyStore, "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(
        () => `
          set @date_start = '2026-07-04 00:00:00';

          select * from sa_access_decision_log AS fp
          where fp.create_at < @date_start;
        `,
      ),
      activeOutputView,
    });

    await execution.tryExecute();

    const executedSql = executeCurrentSql.mock.calls[0]?.[0] ?? "";
    expect(executedSql).toContain("set @date_start = '2026-07-04 00:00:00'");
    expect(executedSql).toContain("where fp.create_at < @date_start");
  });

  it("sends Doris STRUCT DDL unchanged without opening the parameter dialog", async () => {
    const sql = `
      create table \`events\` (
        \`field0\` int not null comment 'field 0',
        \`field_list\` array<struct<field1:smallint, field2:int, field3:decimal(16,5), field4:varchar(255)>> comment 'field list'
      )
      engine = olap
      properties ("replication_num" = "1");
    `;
    const activeTab = ref<QueryTab | undefined>(queryTab("analytics"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("doris"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["ok"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    vi.spyOn(useConnectionStore(), "refreshObjectListTreeNode").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, {});
  });

  it("records a later MySQL batch error and skips metadata refresh", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    const connectionStore = useConnectionStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      const tab = activeTab.value;
      if (!tab) return;
      const successfulResult = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      tab.result = successfulResult;
      tab.results = [successfulResult, { columns: ["Error"], execution_error: true, rows: [["Duplicate entry '1'"]], affected_rows: 0, execution_time_ms: 1 }];
      tab.activeResultIndex = 0;
    });
    const addHistory = vi.spyOn(historyStore, "add").mockResolvedValue(undefined);
    const refreshObjects = vi.spyOn(connectionStore, "refreshObjectListTreeNode").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "SELECT 1 AS value; CREATE TABLE duplicate_target (id INT)"),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(addHistory).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: "Duplicate entry '1'", affected_rows: undefined }));
    expect(refreshObjects).not.toHaveBeenCalled();
  });

  it("does not treat an unmarked MySQL Error alias as a batch failure", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      const tab = activeTab.value;
      if (!tab) return;
      const successfulResult = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      tab.result = successfulResult;
      tab.results = [successfulResult, { columns: ["Error"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 }];
      tab.activeResultIndex = 0;
    });
    const addHistory = vi.spyOn(historyStore, "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "SELECT 1 AS value; SELECT 2 AS Error"),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(addHistory).toHaveBeenCalledWith(expect.objectContaining({ success: true, error: undefined }));
  });

  it("continues to record active non-MySQL errors as failures", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["Error"], rows: [["relation does not exist"]], affected_rows: 0, execution_time_ms: 1 };
    });
    const addHistory = vi.spyOn(historyStore, "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "SELECT * FROM missing_table"),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(addHistory).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: "relation does not exist" }));
  });

  it("keeps the full dangerous script pending and executes it unchanged after confirmation", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const sql = Array.from({ length: 40_000 }, (_, index) => `${index === 0 ? "DROP TABLE IF EXISTS t;" : ""} INSERT INTO t VALUES (${index});`).join("\n");
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 40_000, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(execution.showDangerDialog.value).toBe(true);
    expect(execution.pendingDangerSql.value).toBe(sql);
    expect(executeCurrentSql).not.toHaveBeenCalled();

    await execution.onDangerConfirm();

    expect(executeCurrentSql).toHaveBeenCalledWith(sql, {});
  });

  it("requires production confirmation even when ordinary danger prompts are disabled", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("prod_app"));
    const activeConnection = ref<ConnectionConfig | undefined>({ ...connection("mysql"), production_databases: ["prod_app"] });
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const settingsStore = useSettingsStore();
    const productionSafetyStore = useProductionSafetyStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["ok"], rows: [[1]], affected_rows: 1, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    settingsStore.editorSettings.confirmDangerousSqlExecution = false;

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "UPDATE users SET active = 1 WHERE id = 7"),
      activeOutputView,
    });

    const pendingExecution = execution.tryExecute();
    await Promise.resolve();
    expect(productionSafetyStore.pending?.sql).toContain("UPDATE users");
    expect(executeCurrentSql).not.toHaveBeenCalled();

    productionSafetyStore.confirm();
    await pendingExecution;
    expect(executeCurrentSql).toHaveBeenCalledTimes(1);
  });
});
