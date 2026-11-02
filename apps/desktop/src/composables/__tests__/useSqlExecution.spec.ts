import { computed, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDangerousSql, requiresConnectionSelection, requiresDatabaseSelection, snapshotResultForMerge, supportsSqlTemplateParameters, useSqlExecution } from "../useSqlExecution";
import { useConnectionStore } from "@/stores/connectionStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { createQueryEditorExecutionViewportOwnership } from "@/lib/editor/queryEditorExecutionViewport";
import * as objectMetadataCache from "@/lib/metadata/objectMetadataCache";
import type { ConnectionConfig, QueryTab } from "@/types/database";
import { formatSqlText } from "@/lib/sql/sqlFormatter";
import { normalizeSqlVariableSyntaxOverrides, updateSqlVariableSyntaxToggle } from "@/lib/sql/sqlVariableSyntax";
import type { SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";
import { useReadOnlyUnlockStore } from "@/stores/readOnlyUnlockStore";
import * as api from "@/lib/backend/api";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast }) }));

vi.mock("vue-i18n", () => ({
  createI18n: () => ({ global: { locale: { value: "en" }, setLocaleMessage: vi.fn(), t: (key: string) => key } }),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  saveEditorSettings: vi.fn(),
  saveHistory: vi.fn(),
  unlockConnectionWrites: vi.fn(),
  lockConnectionWrites: vi.fn(),
  connectionWriteUnlockState: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/metadata/objectMetadataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metadata/objectMetadataCache")>();
  return { ...actual, invalidateObjectMetadataCache: vi.fn() };
});

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

describe("compatibility write denial outcomes", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  function setup(legacy = true, sql = "UPDATE users SET name='test' WHERE id=1") {
    const tab = ref<QueryTab>({ ...queryTab("app"), sql });
    const config = ref<ConnectionConfig>({ ...connection("mysql"), url_params: legacy ? "dataCharset=GBK" : "" });
    vi.spyOn(useConnectionStore(), "getConfig").mockImplementation(() => config.value);
    const store = useQueryStore();
    const executeCurrentSql = vi.spyOn(store, "executeCurrentSql").mockResolvedValue(undefined);
    const executeTabSql = vi.spyOn(store, "executeTabSql").mockResolvedValue(undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const onDeferredExecutionSettled = vi.fn();
    const execution = useSqlExecution({ activeTab: computed(() => tab.value), activeConnection: computed(() => config.value), executableSql: computed(() => sql), activeOutputView: ref("result"), onDeferredExecutionSettled });
    return { tab, config, execution, executeCurrentSql, executeTabSql, onDeferredExecutionSettled };
  }

  it.each([false, true])("reports blocked without submitting SQL or unlocking (new result: %s)", async (newResult) => {
    const { config, execution, executeCurrentSql, executeTabSql } = setup();
    useReadOnlyUnlockStore().rememberWindow(config.value.id, 60000);
    const before = { ...config.value };
    const result = await (newResult ? execution.tryExecuteInNewResultTab() : execution.tryExecute());
    expect(result).toEqual({ status: "not-started", reason: "blocked", tabId: "tab-1" });
    expect(toast).toHaveBeenCalledExactlyOnceWith("connection.mysqlDataCharsetWriteBlocked", 5000);
    expect(executeCurrentSql).not.toHaveBeenCalled();
    expect(executeTabSql).not.toHaveBeenCalled();
    expect(api.unlockConnectionWrites).not.toHaveBeenCalled();
    expect(useReadOnlyUnlockStore().pending).toBeUndefined();
    expect(config.value).toEqual(before);
  });

  it.each([true, false])("allows SELECT silently (compatibility: %s)", async (legacy) => {
    const { execution, executeCurrentSql } = setup(legacy, "SELECT 1");
    await execution.tryExecute();
    expect(executeCurrentSql).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });

  it("preserves ordinary write execution without the compatibility notification", async () => {
    const { execution, executeCurrentSql } = setup(false);
    useSettingsStore().editorSettings.confirmDangerousSqlExecution = false;
    await execution.tryExecute();
    expect(executeCurrentSql).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });

  it("keeps ordinary unlock dismissal cancelled", async () => {
    const { config, execution, executeCurrentSql } = setup(false);
    config.value.read_only = true;
    const running = execution.tryExecute();
    await vi.waitFor(() => expect(useReadOnlyUnlockStore().pending).toBeDefined());
    useReadOnlyUnlockStore().cancel();
    expect(await running).toEqual({ status: "not-started", reason: "cancelled", tabId: "tab-1" });
    expect(executeCurrentSql).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("rechecks compatibility after danger confirmation and reports blocked", async () => {
    const { config, execution, executeCurrentSql, onDeferredExecutionSettled } = setup(false);
    useSettingsStore().editorSettings.confirmDangerousSqlExecution = true;
    expect(await execution.tryExecute()).toMatchObject({ status: "deferred" });
    config.value.url_params = "dataCharset=GBK";
    await execution.onDangerConfirm();
    expect(onDeferredExecutionSettled).toHaveBeenCalledWith({ status: "not-started", reason: "blocked", tabId: "tab-1" });
    expect(executeCurrentSql).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledExactlyOnceWith("connection.mysqlDataCharsetWriteBlocked", 5000);
  });

  it("reports the explicit compatibility reason for multi-database denial", async () => {
    const { config, tab, execution, executeCurrentSql, executeTabSql } = setup();
    const result = await execution.executeTargetSql({ tab: tab.value, connection: config.value, sql: tab.value.sql });
    expect(result).toMatchObject({ status: "skipped", errorMessage: "connection.mysqlDataCharsetWriteBlocked" });
    expect(executeCurrentSql).not.toHaveBeenCalled();
    expect(executeTabSql).not.toHaveBeenCalled();
    expect(api.unlockConnectionWrites).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledExactlyOnceWith("connection.mysqlDataCharsetWriteBlocked", 5000);
  });
});

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

describe("requiresConnectionSelection", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("requires a connection for a query tab without one", () => {
    const tab = queryTab();
    tab.connectionId = "";
    expect(requiresConnectionSelection(tab, undefined)).toBe(true);
  });

  it("does not require a connection when one is resolved", () => {
    expect(requiresConnectionSelection(queryTab(), connection("mysql"))).toBe(false);
  });

  it("never requires a connection for non-query tabs", () => {
    const tab = queryTab();
    tab.mode = "databases";
    expect(requiresConnectionSelection(tab, undefined)).toBe(false);
  });
});

describe("supportsSqlTemplateParameters", () => {
  it("disables SQL parameter prompts for Meilisearch input", () => {
    expect(supportsSqlTemplateParameters(connection("meilisearch"), "GET /indexes/:uid")).toBe(false);
    expect(supportsSqlTemplateParameters(connection("meilisearch"), "plain :value")).toBe(false);
  });
});

describe("useSqlExecution", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
    vi.mocked(objectMetadataCache.invalidateObjectMetadataCache).mockClear();
  });

  it.each([
    ["pg", "SELECT data ? 'name' FROM events"],
    ["oracle", "SELECT 1 FROM DUAL@remote_db"],
    ["mysql", "CREATE PROCEDURE p() BEGIN label_1: LOOP LEAVE label_1; END LOOP; END"],
    ["sqlserver", "DECLARE @id int; SET @id = 1; SELECT @id;"],
  ])("does not mistake Kingbase %s server syntax for template parameters", async (mode, sql) => {
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>({ ...connection("kingbase"), database_info: { compatibilityMode: mode } });
    const execute = vi.spyOn(useQueryStore(), "executeCurrentSql").mockResolvedValue(undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({ activeTab: computed(() => activeTab.value), activeConnection: computed(() => activeConnection.value), executableSql: computed(() => sql), activeOutputView: ref("result") });
    await execution.tryExecute();
    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execute).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
  });

  it.each([
    ["BEGIN", "DROP PROCEDURE IF EXISTS p;\nCREATE DEFINER=`root`@`127.0.0.1` PROCEDURE p(IN in_username VARCHAR(200))\nrun:BEGIN IF in_username = '' THEN LEAVE run; END IF; SELECT in_username; END;"],
    ["LOOP", "CREATE PROCEDURE p() lbl:LOOP LEAVE lbl; END LOOP lbl;"],
    ["WHILE", "CREATE PROCEDURE p() lbl:WHILE FALSE DO SELECT 1; END WHILE lbl;"],
    ["REPEAT", "CREATE PROCEDURE p() lbl:REPEAT LEAVE lbl; UNTIL TRUE END REPEAT lbl;"],
  ])("executes a MySQL procedure with a compact outer %s label without opening the parameter dialog (#13242)", async (_kind, sql) => {
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    useSettingsStore().editorSettings.confirmDangerousSqlExecution = false;
    const execute = vi.spyOn(useQueryStore(), "executeCurrentSql").mockResolvedValue(undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({ activeTab: computed(() => activeTab.value), activeConnection: computed(() => activeConnection.value), executableSql: computed(() => sql), activeOutputView: ref("result") });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(execute).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
  });

  it("executes Neo4j graph patterns without a SQL parameter dialog", async () => {
    const sql = 'MATCH (p:Person)-[:WORK_IN]->(c:Company{name:"星云科技"})\nRETURN p.name, p.job, c.name';
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("neo4j"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("neo4j"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["p.name"], rows: [["Ada"]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
  });

  it("prompts for a connection instead of executing when no connection is selected", async () => {
    const sql = "SELECT 1";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab(), connectionId: "", sql });
    const activeConnection = ref<ConnectionConfig | undefined>(undefined);
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockResolvedValue(undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const onMissingConnection = vi.fn();

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
      onMissingConnection,
    });

    await execution.tryExecute();

    expect(onMissingConnection).toHaveBeenCalledWith("tab-1");
    expect(executeCurrentSql).not.toHaveBeenCalled();
  });

  it("invalidates object metadata after successful connection-level DDL", async () => {
    const sql = "CREATE DATABASE app_db";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab(), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const invalidateMetadata = vi.spyOn(connectionStore, "invalidateMetadataCache");
    const loadDatabases = vi.spyOn(connectionStore, "loadDatabases").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(invalidateMetadata).toHaveBeenCalledWith("conn-1");
    expect(loadDatabases).toHaveBeenCalledWith("conn-1", { force: true });
  });

  it("invalidates table facets after successful Kingbase constraint DDL", async () => {
    const sql = "ALTER TABLE public.orders DISABLE CONSTRAINT orders_check";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), schema: "public", sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("kingbase"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    useSettingsStore().editorSettings.confirmDangerousSqlExecution = false;
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const invalidateObjectMetadata = vi.mocked(objectMetadataCache.invalidateObjectMetadataCache).mockResolvedValue(undefined);
    const refreshObjects = vi.spyOn(connectionStore, "refreshObjectListTreeNode").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
      requestDangerConfirmation: async () => true,
    });

    await execution.tryExecute();

    expect(invalidateObjectMetadata).toHaveBeenCalledWith({ connectionId: "conn-1", database: "app", schema: "public" });
    expect(refreshObjects).toHaveBeenCalledWith("conn-1", "app", "public");
  });

  it("rejects execution when the target tab is already executing", async () => {
    const sql = "SELECT 1;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql, isExecuting: true });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql");
    const onExecutionCancelled = vi.fn();

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
      onExecutionCancelled,
    });

    const outcome = await execution.tryExecute(undefined, { editorViewportRequestId: 123 });

    expect(outcome).toEqual({ status: "not-started", reason: "busy", tabId: "tab-1" });
    expect(executeCurrentSql).not.toHaveBeenCalled();
    expect(onExecutionCancelled).toHaveBeenCalledWith(123);
  });

  it("sends every placeholder syntax and @set unchanged when substitution is disabled", async () => {
    const sql = ["@set tenant = 42;", "SELECT ?, :named, ${shell}, #{mybatis}, @sqlserver, @tenant;"].join("\n");
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const settingsStore = useSettingsStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["ok"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    settingsStore.editorSettings.sqlVariableSubstitutionEnabled = false;

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
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

    expect(executeCurrentSql).toHaveBeenCalledWith(selectedSql, { tabId: "tab-1", sourceOffset: selectionFrom });
  });

  it("keeps a toolbar snapshot bound to its owning tab when focus changes", async () => {
    const fullSql = "SELECT active_value;\nSELECT selected_value;";
    const selectedSql = "SELECT selected_value;";
    const selectionFrom = fullSql.indexOf(selectedSql);
    const activeTabValue = { ...queryTab("app"), id: "tab-a", sql: "SELECT active_value;" };
    const executionTabValue = { ...queryTab("app"), id: "tab-b", sql: fullSql };
    const activeTab = ref<QueryTab | undefined>(activeTabValue);
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    connectionStore.connections = [connection("mysql")];
    queryStore.tabs = [activeTabValue, executionTabValue];
    queryStore.activeTabId = activeTabValue.id;
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const resolveExecutableSql = vi.fn(async (snapshot: SqlExecutionSnapshot | undefined, tab?: QueryTab) => {
      expect(tab?.id).toBe("tab-b");
      return snapshot?.selectedSql ?? "";
    });
    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => activeTab.value?.sql ?? ""),
      resolveExecutableSql,
      activeOutputView,
    });

    await execution.tryExecute(
      {
        fullSql,
        selectedSql,
        cursorPos: selectionFrom,
        selectionFrom,
        selectionTo: fullSql.length,
      },
      { tabId: executionTabValue.id },
    );

    expect(resolveExecutableSql).toHaveBeenCalledWith(expect.objectContaining({ selectedSql }), executionTabValue);
    expect(executeCurrentSql).toHaveBeenCalledWith(selectedSql, { tabId: executionTabValue.id, sourceOffset: selectionFrom });
  });

  it("expands preceding @set values in a selected shell-style statement", async () => {
    const selectedSql = "SELECT * FROM patrol WHERE post_id = ${postid};";
    const fullSql = ["-- saved query", "@set postid='224';", selectedSql, "@set postid = 'future';"].join("\n");
    const selectionFrom = fullSql.indexOf("SELECT");
    const selectionTo = selectionFrom + selectedSql.length;
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql: fullSql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["post_id"], rows: [["224"]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => selectedSql),
      resolveExecutableSql: async () => selectedSql,
      activeOutputView,
    });

    await execution.tryExecute({ fullSql, selectedSql, cursorPos: selectionFrom, selectionFrom, selectionTo });

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(executeCurrentSql).toHaveBeenCalledWith("SELECT * FROM patrol WHERE post_id = '224';", { tabId: "tab-1" });
  });

  it("executes an unsemicoloned @set followed by a query without producing empty SQL or silently cancelling", async () => {
    const sql = ["@set user_id = 42", "select * from users where id = @user_id"].join("\n");
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [["42"]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      resolveExecutableSql: async () => sql,
      activeOutputView,
    });

    await execution.tryExecute(sql);

    expect(executeCurrentSql).toHaveBeenCalledWith("select * from users where id = 42", { tabId: "tab-1" });
  });

  it.each([
    { sql: "UPDATE users SET name = 'Ada' WHERE id = 1", returnsRows: false },
    { sql: "INSERT INTO users(id) VALUES (1) RETURNING id", returnsRows: true },
  ])("shows a running write in summary and restores returned rows: $sql", async ({ sql, returnsRows }) => {
    useSettingsStore().editorSettings.confirmDangerousSqlExecution = false;
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    let finishExecution!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const execute = vi.spyOn(useQueryStore(), "executeCurrentSql").mockImplementation(async () => {
      await completion;
      activeTab.value!.result = {
        columns: returnsRows ? ["id"] : [],
        rows: returnsRows ? [[1]] : [],
        affected_rows: 1,
        execution_time_ms: 1,
      };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    const pending = execution.tryExecute();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(activeOutputView.value).toBe("summary");
    finishExecution();
    await pending;
    expect(activeOutputView.value).toBe(returnsRows ? "result" : "summary");
  });

  it("opens the result table for a multi-statement batch by default", async () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("result");
  });

  it("reads the latest multi-statement default view on each execution in the same tab", async () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    useSettingsStore().editorSettings.multiStatementDefaultView = "summary";
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    for (const view of ["summary", "result", "summary"] as const) {
      useSettingsStore().editorSettings.multiStatementDefaultView = view;
      await execution.tryExecute();
      expect(activeOutputView.value).toBe(view);
    }
  });

  it("does not change the current output view when a background tab finishes", async () => {
    const sql = "SELECT run_side_effect()";
    const executionTab = { ...queryTab("app"), sql };
    const activeTab = ref<QueryTab | undefined>(executionTab);
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const queryStore = useQueryStore();
    let finishExecution!: () => void;
    const executionFinished = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      await executionFinished;
      executionTab.result = { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    const pending = execution.tryExecute();
    await vi.waitFor(() => expect(executeCurrentSql).toHaveBeenCalledOnce());
    activeTab.value = { ...queryTab("app"), id: "tab-2" };
    activeOutputView.value = "messages";
    finishExecution();
    await pending;

    expect(activeOutputView.value).toBe("messages");
  });

  it("shows SQL Server PRINT messages instead of leaving them behind the execution summary", async () => {
    const sql = `IF 1 = 1
BEGIN
  PRINT 'x';
END
ELSE
BEGIN
  PRINT 'y';
END
GO`;
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("dbx_sqlserver_demo"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("sqlserver"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["Message"], column_types: ["nvarchar"], rows: [["x"]], affected_rows: 0, execution_time_ms: 1, server_message: true };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeTab.value?.result?.rows).toEqual([["x"]]);
    expect(activeOutputView.value).toBe("messages");
  });

  it("keeps a SQL Server data result selected when a trailing message result exists", async () => {
    const sql = "SELECT 1 AS value; PRINT N'x';";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("dbx_sqlserver_demo"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("sqlserver"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const setActiveResultIndex = vi.spyOn(queryStore, "setActiveResultIndex").mockImplementation((_id, index) => {
      if (!activeTab.value?.results) return;
      activeTab.value.activeResultIndex = index;
      activeTab.value.result = activeTab.value.results[index];
    });
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (!activeTab.value) return;
      const dataResult = { columns: ["value"], column_types: ["int"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      const messageResult = { columns: ["Message"], column_types: ["nvarchar"], rows: [["x"]], affected_rows: 0, execution_time_ms: 1, server_message: true };
      activeTab.value.results = [dataResult, messageResult];
      activeTab.value.activeResultIndex = 0;
      activeTab.value.result = dataResult;
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("result");
    expect(setActiveResultIndex).not.toHaveBeenCalled();
    expect(activeTab.value?.activeResultIndex).toBe(0);
    expect(activeTab.value?.result?.server_message).toBeUndefined();
    expect(activeTab.value?.result?.rows).toEqual([[1]]);
  });

  it("selects a SQL Server data result after an earlier message result", async () => {
    const sql = "PRINT N'x'; SELECT 1 AS value;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("dbx_sqlserver_demo"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("sqlserver"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const setActiveResultIndex = vi.spyOn(queryStore, "setActiveResultIndex").mockImplementation((_id, index) => {
      if (!activeTab.value?.results) return;
      activeTab.value.activeResultIndex = index;
      activeTab.value.result = activeTab.value.results[index];
    });
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (!activeTab.value) return;
      const messageResult = { columns: ["Message"], column_types: ["nvarchar"], rows: [["x"]], affected_rows: 0, execution_time_ms: 1, server_message: true } as const;
      const dataResult = { columns: ["value"], column_types: ["int"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      activeTab.value.results = [messageResult, dataResult];
      activeTab.value.activeResultIndex = 0;
      activeTab.value.result = messageResult;
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("result");
    expect(setActiveResultIndex).toHaveBeenCalledWith("tab-1", 1);
    expect(activeTab.value?.activeResultIndex).toBe(1);
    expect(activeTab.value?.result?.rows).toEqual([[1]]);
  });

  it("keeps a SQL Server execution error selected when a message result also exists", async () => {
    const sql = "SELECT missing_column FROM demo;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("dbx_sqlserver_demo"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("sqlserver"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const setActiveResultIndex = vi.spyOn(queryStore, "setActiveResultIndex");
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (!activeTab.value) return;
      const messageResult = { columns: ["Message"], column_types: ["nvarchar"], rows: [["before error"]], affected_rows: 0, execution_time_ms: 1, server_message: true };
      const errorResult = { columns: ["Error"], column_types: ["string"], rows: [["Invalid column name"]], affected_rows: 0, execution_time_ms: 1, execution_error: true };
      activeTab.value.results = [messageResult, errorResult];
      activeTab.value.activeResultIndex = 1;
      activeTab.value.result = errorResult;
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(setActiveResultIndex).not.toHaveBeenCalled();
    expect(activeTab.value?.activeResultIndex).toBe(1);
    expect(activeTab.value?.result?.execution_error).toBe(true);
  });

  it("opens ordinary SQL Server multi-result batches in the result table by default", async () => {
    const sql = "SELECT 1 AS first_value; SELECT 2 AS second_value;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("dbx_sqlserver_demo"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("sqlserver"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const setActiveResultIndex = vi.spyOn(queryStore, "setActiveResultIndex");
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (!activeTab.value) return;
      const firstResult = { columns: ["first_value"], column_types: ["int"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      const secondResult = { columns: ["second_value"], column_types: ["int"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 };
      activeTab.value.results = [firstResult, secondResult];
      activeTab.value.activeResultIndex = 0;
      activeTab.value.result = firstResult;
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("result");
    expect(setActiveResultIndex).not.toHaveBeenCalled();
    expect(activeTab.value?.result?.rows).toEqual([[1]]);
  });

  it("opens ordinary SQL Server data aliased as Message in the result table by default", async () => {
    const sql = `DECLARE @value nvarchar(1) = N'x';
SELECT @value AS Message;`;
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("dbx_sqlserver_demo"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("sqlserver"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["Message"], column_types: ["nvarchar"], rows: [["x"]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("result");
    expect(activeTab.value?.result?.rows).toEqual([["x"]]);
  });

  it("opens the messages view for a message-only result", async () => {
    const sql = "DO $$ BEGIN RAISE NOTICE 'hello'; END $$;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, messages: [{ severity: "NOTICE", message: "hello", code: "00000" }] };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("messages");
  });

  it("keeps Messages selected after a batch with live output completes", async () => {
    const sql = "SET client_min_messages = NOTICE; DO $$ BEGIN RAISE NOTICE 'hello'; END $$;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    vi.spyOn(useQueryStore(), "executeCurrentSql").mockImplementation(async () => {
      activeOutputView.value = "messages";
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, messages: [{ severity: "NOTICE", message: "hello" }] };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });
    await execution.tryExecute();
    expect(activeOutputView.value).toBe("messages");
  });

  it("keeps the summary view for a MySQL INSERT that carries an INFO message", async () => {
    const sql = "INSERT INTO users (name) VALUES ('a'), ('b')";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 2, execution_time_ms: 1, messages: [{ severity: "Note", message: "Records: 2  Duplicates: 0  Warnings: 0" }] };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("summary");
  });

  it("keeps the summary view for a batch whose statements emit messages", async () => {
    const sql = "DO $$ BEGIN RAISE NOTICE 'one'; END $$;\nDO $$ BEGIN RAISE NOTICE 'two'; END $$;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value)
        activeTab.value.result = {
          columns: [],
          rows: [],
          affected_rows: 0,
          execution_time_ms: 1,
          messages: [
            { severity: "NOTICE", message: "one" },
            { severity: "NOTICE", message: "two" },
          ],
        };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("summary");
  });

  it("keeps the result view when messages accompany a tabular result", async () => {
    const sql = "SELECT 1";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, messages: [{ severity: "NOTICE", message: "hello" }] };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("result");
  });

  it("returns to the result view when a notice arrived before a PostgreSQL function's result set", async () => {
    // Regression for #11822: `SELECT some_function()` emits a NOTICE while it runs and then
    // returns rows. The live-output watcher in ContentArea advances to Messages as soon as the
    // notice lands, because the rows do not exist yet. With a result set present the completion
    // path used to skip every branch, so the view stayed on Messages instead of showing the data.
    const sql = "SELECT log_and_return()";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      // Mirrors the real order of events: the notice is surfaced live and the view moves to
      // Messages, then the statement finishes with a tabular result.
      activeOutputView.value = "messages";
      if (activeTab.value) {
        activeTab.value.uiState = { ...activeTab.value.uiState, autoSwitchedToMessagesDuringExecution: true };
        activeTab.value.result = { columns: ["log_and_return"], rows: [["done"]], affected_rows: 0, execution_time_ms: 1, messages: [{ severity: "NOTICE", message: "working" }] };
      }
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeTab.value?.result?.rows).toEqual([["done"]]);
    expect(activeOutputView.value).toBe("result");
    expect(activeTab.value?.uiState?.autoSwitchedToMessagesDuringExecution).toBe(false);
  });

  it("keeps Messages selected when a completed run produced no tabular result", async () => {
    const sql = "DO $$ BEGIN RAISE NOTICE 'hello'; END $$;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      activeOutputView.value = "messages";
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, messages: [{ severity: "NOTICE", message: "hello" }] };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("messages");
  });

  it("does not pull a background tab's Messages view away from the tab the user is looking at", async () => {
    const sql = "SELECT log_and_return()";
    const executionTab = { ...queryTab("app"), sql };
    const activeTab = ref<QueryTab | undefined>(executionTab);
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const queryStore = useQueryStore();
    let finishExecution!: () => void;
    const executionFinished = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      await executionFinished;
      executionTab.result = { columns: ["log_and_return"], rows: [["done"]], affected_rows: 0, execution_time_ms: 1, messages: [{ severity: "NOTICE", message: "working" }] };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    const pending = execution.tryExecute();
    await vi.waitFor(() => expect(executeCurrentSql).toHaveBeenCalledOnce());
    activeTab.value = { ...queryTab("app"), id: "tab-2" };
    activeOutputView.value = "messages";
    finishExecution();
    await pending;

    expect(activeOutputView.value).toBe("messages");
  });

  it("redirects from messages to result when tabular data is produced after auto-switching (#11822)", async () => {
    const sql = "SELECT * FROM test_func_with_info()";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    vi.spyOn(useQueryStore(), "executeCurrentSql").mockImplementation(async () => {
      activeOutputView.value = "messages";
      if (activeTab.value) {
        activeTab.value.uiState = { ...activeTab.value.uiState, autoSwitchedToMessagesDuringExecution: true };
        activeTab.value.result = {
          columns: ["val"],
          rows: [[1]],
          affected_rows: 0,
          execution_time_ms: 1,
          messages: [{ severity: "INFO", message: "function info message" }],
        };
      }
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("result");
    expect(activeTab.value?.uiState?.autoSwitchedToMessagesDuringExecution).toBe(false);
  });

  it("does not redirect from messages when query fails with error result (#11822)", async () => {
    const sql = "SELECT * FROM test_func_with_error()";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    vi.spyOn(useQueryStore(), "executeCurrentSql").mockImplementation(async () => {
      activeOutputView.value = "messages";
      if (activeTab.value) {
        activeTab.value.uiState = { ...activeTab.value.uiState, autoSwitchedToMessagesDuringExecution: true };
        activeTab.value.result = {
          columns: ["Error"],
          execution_error: true,
          rows: [["function exception"]],
          affected_rows: 0,
          execution_time_ms: 1,
          messages: [{ severity: "INFO", message: "function info message" }],
        };
      }
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("messages");
    expect(activeTab.value?.uiState?.autoSwitchedToMessagesDuringExecution).toBe(false);
  });

  it("does not redirect when user manually switched to messages mid-run (#11822)", async () => {
    const sql = "SELECT * FROM test_func_with_info()";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    vi.spyOn(useQueryStore(), "executeCurrentSql").mockImplementation(async () => {
      activeOutputView.value = "messages";
      if (activeTab.value) {
        // User manually selected messages mid-run, so autoSwitchedToMessagesDuringExecution is false
        activeTab.value.uiState = { ...activeTab.value.uiState, autoSwitchedToMessagesDuringExecution: false };
        activeTab.value.result = {
          columns: ["val"],
          rows: [[1]],
          affected_rows: 0,
          execution_time_ms: 1,
        };
      }
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("messages");
  });

  it("honors multiStatementDefaultView when redirecting multi-statement execution (#11822)", async () => {
    const sql = "SELECT 1; SELECT 2;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.multiStatementDefaultView = "summary";

    vi.spyOn(useQueryStore(), "executeCurrentSql").mockImplementation(async () => {
      activeOutputView.value = "messages";
      if (activeTab.value) {
        activeTab.value.uiState = { ...activeTab.value.uiState, autoSwitchedToMessagesDuringExecution: true };
        activeTab.value.result = {
          columns: ["val"],
          rows: [[1]],
          affected_rows: 0,
          execution_time_ms: 1,
        };
        activeTab.value.results = [activeTab.value.result];
      }
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("summary");
  });

  it("redirects background tab uiState to result when query finishes while tab is inactive (#11822)", async () => {
    const sql = "SELECT * FROM test_func_with_info()";
    const tab1: QueryTab = { ...queryTab("app"), id: "tab-1", sql, uiState: { activeOutputView: "messages", autoSwitchedToMessagesDuringExecution: true } };
    const tab2: QueryTab = { ...queryTab("app"), id: "tab-2", sql: "SELECT 2", uiState: { activeOutputView: "chart" } };
    const queryStore = useQueryStore();
    queryStore.tabs = [tab1, tab2];
    const activeTab = ref<QueryTab | undefined>(tab2);
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("chart");

    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async (_sql, options) => {
      const targetTab = queryStore.tabs.find((t) => t.id === options?.tabId);
      if (targetTab) {
        targetTab.uiState = { ...targetTab.uiState, activeOutputView: "messages", autoSwitchedToMessagesDuringExecution: true };
        targetTab.result = {
          columns: ["val"],
          rows: [[1]],
          affected_rows: 0,
          execution_time_ms: 1,
        };
      }
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute(undefined, { tabId: tab1.id });

    // Active tab (tab2) output view should remain untouched
    expect(activeOutputView.value).toBe("chart");
    // Background tab (tab1) uiState should have redirected to "result"
    expect(tab1.uiState?.activeOutputView).toBe("result");
    expect(tab1.uiState?.autoSwitchedToMessagesDuringExecution).toBe(false);
  });

  it("forwards execute-in-new-result-tab intent to the query store", async () => {
    const sql = "SELECT * FROM users";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
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
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecuteInNewResultTab();

    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1", openInNewResultTab: true });
  });

  it("does not record or refresh when a new-result execution restores the prior run", async () => {
    const result = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), result });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockResolvedValue(false);
    const addHistory = vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const refreshObjects = vi.spyOn(useConnectionStore(), "refreshObjectListTreeNode").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "CREATE TABLE users (id INT)"),
      activeOutputView,
    });

    await execution.tryExecuteInNewResultTab();

    expect(addHistory).not.toHaveBeenCalled();
    expect(refreshObjects).not.toHaveBeenCalled();
  });

  it("keeps the new-result-tab intent through SQL parameter input", async () => {
    const sql = "SELECT * FROM users WHERE id = :id";
    const resolvedSql = "SELECT * FROM users WHERE id = 7";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[7]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecuteInNewResultTab();

    expect(execution.showSqlParameterDialog.value).toBe(true);
    expect(executeCurrentSql).not.toHaveBeenCalled();

    await execution.onSqlParametersConfirm(resolvedSql);

    expect(executeCurrentSql).toHaveBeenCalledWith(resolvedSql, { tabId: "tab-1", openInNewResultTab: true });
  });

  it("settles a failed execution after accepting a SQL parameter dialog", async () => {
    const sql = "SELECT * FROM users WHERE id = :id";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    vi.spyOn(useQueryStore(), "executeCurrentSql").mockRejectedValue(new Error("connection lost"));
    const onDeferredExecutionSettled = vi.fn();

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
      onDeferredExecutionSettled,
    });

    await execution.tryExecute();
    await execution.onSqlParametersConfirm("SELECT * FROM users WHERE id = 7");

    expect(onDeferredExecutionSettled).toHaveBeenCalledWith({ status: "started", ok: false, errorMessage: "connection lost", tabId: "tab-1" });
  });

  it("executes the PostgreSQL ARRAY date-format query without opening the parameter dialog", async () => {
    const sql = `
      WITH rec_flow AS (
        SELECT
          order_no,
          ARRAY[
            concat(
              operator_name, '(', COALESCE(remark, ''), ')[',
              CASE operate_action
                WHEN 'CREATE' THEN '创建工单'
                WHEN 'SUBMIT' THEN '提交至下一处理人'
                WHEN 'BACK' THEN '退回上一环节'
                WHEN 'FINISH' THEN '已完成'
                WHEN 'SUBMIT-CONFIRM' THEN '提交给创建人确认'
                WHEN 'COMPLETE' THEN '确认工单'
                ELSE operate_action
              END, ']'
            )
          ]::varchar[]
          || CASE
            WHEN operate_action NOT IN ('FINISH','COMPLETE')
              THEN ARRAY[target_handler_name]::varchar[]
            ELSE ARRAY[]::varchar[]
          END AS name_arr,
          rn
        FROM (
          SELECT
            'ORD20260821001' AS order_no,
            '张三' AS operator_name,
            '发起流程' AS remark,
            'SUBMIT' AS operate_action,
            '李四' AS target_handler_name,
            1 AS rn
        ) AS mock_t3_flow
      )
      SELECT to_char(current_timestamp, 'yyyy-MM-dd HH24:mi:ss');
    `;
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
  });

  it.each([
    { databaseType: "oracle", database: "ORCL", sql: "SELECT 1 FROM DUAL@WDHIS160;" },
    { databaseType: "dameng", database: "test", sql: "select * from test.table_name@dm1" },
  ] as const)("executes $databaseType database-link queries without opening the parameter dialog", async ({ databaseType, database, sql }) => {
    const activeTab = ref<QueryTab | undefined>(queryTab(database));
    const activeConnection = ref<ConnectionConfig | undefined>(connection(databaseType));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["1"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
  });

  it("executes a formatted Dameng DBLink query without a parameter dialog or SQL changes", async () => {
    const sql = await formatSqlText("select * from test.table_name@dm1", "dameng");
    expect(sql).toContain("table_name @dm1");
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("test"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("dameng"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const executeCurrentSql = vi.spyOn(useQueryStore(), "executeCurrentSql").mockResolvedValue(undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({ activeTab: computed(() => activeTab.value), activeConnection: computed(() => activeConnection.value), executableSql: computed(() => sql), activeOutputView });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
  });

  it.each(["", " ", "/* separator */", "-- separator\n"])("preserves a Dameng link separated by %j in the full @set execution flow", async (separator) => {
    const target = `select * from test.table_name${separator}@dm1 where id=@DM1`;
    const sql = `@set dm1 = 7;\n${target}`;
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("test"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("dameng"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const executeCurrentSql = vi.spyOn(useQueryStore(), "executeCurrentSql").mockResolvedValue(undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({ activeTab: computed(() => activeTab.value), activeConnection: computed(() => activeConnection.value), executableSql: computed(() => sql), activeOutputView });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith(`select * from test.table_name${separator}@dm1 where id=7`, { tabId: "tab-1" });
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("executes %s XML templates without treating CONTENT as a linked object", async (databaseType) => {
    const sql = "@set value = XMLTYPE('<a/>');\nSELECT XMLSERIALIZE(CONTENT @value AS CLOB) FROM DUAL";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("test"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection(databaseType));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const executeCurrentSql = vi.spyOn(useQueryStore(), "executeCurrentSql").mockResolvedValue(undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({ activeTab: computed(() => activeTab.value), activeConnection: computed(() => activeConnection.value), executableSql: computed(() => sql), activeOutputView });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith("SELECT XMLSERIALIZE(CONTENT XMLTYPE('<a/>') AS CLOB) FROM DUAL", { tabId: "tab-1" });
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("expands %s SQL/XML function names before execution", async (databaseType) => {
    const selectedSql = "SELECT XMLSERIALIZE(CONTENT @fn('<a/>') AS CLOB) FROM DUAL";
    const sql = `@set fn = XMLTYPE;\n${selectedSql}`;
    const selectionFrom = sql.indexOf("SELECT");
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("test"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection(databaseType));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const executeCurrentSql = vi.spyOn(useQueryStore(), "executeCurrentSql").mockResolvedValue(undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({ activeTab: computed(() => activeTab.value), activeConnection: computed(() => activeConnection.value), executableSql: computed(() => sql), activeOutputView });

    await execution.tryExecute();
    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(executeCurrentSql).toHaveBeenLastCalledWith("SELECT XMLSERIALIZE(CONTENT XMLTYPE('<a/>') AS CLOB) FROM DUAL", { tabId: "tab-1" });

    await execution.tryExecute({ fullSql: sql, selectedSql, cursorPos: selectionFrom, selectionFrom, selectionTo: sql.length });
    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(executeCurrentSql).toHaveBeenCalledTimes(2);
    expect(executeCurrentSql).toHaveBeenLastCalledWith("SELECT XMLSERIALIZE(CONTENT XMLTYPE('<a/>') AS CLOB) FROM DUAL", { tabId: "tab-1" });
  });

  it.each([
    { databaseType: "oracle", target: "SELECT XMLQUERY('/a' PASSING BY VALUE @fn('<a/>') RETURNING CONTENT) FROM DUAL", value: "XMLTYPE" },
    { databaseType: "oracle", target: "SELECT XMLTABLE('/a' PASSING @fn('<a/>') COLUMNS name VARCHAR2(50) PATH '.') FROM DUAL", value: "XMLTYPE" },
    { databaseType: "dameng", target: "SELECT XMLTABLE('/a' PASSING BY VALUE @fn('<a/>') COLUMNS name VARCHAR2(50) PATH '.') FROM DUAL", value: "XMLTYPE" },
    { databaseType: "oceanbase-oracle", target: "SELECT XMLQUERY('/a' PASSING BY VALUE @fn('<a/>') RETURNING CONTENT) FROM DUAL", value: "XMLTYPE" },
    { databaseType: "oracle", target: "BEGIN @fn('ok'); END;", value: "DBMS_OUTPUT.PUT_LINE" },
    { databaseType: "oceanbase-oracle", target: "BEGIN LOOP @fn('ok'); EXIT; END LOOP; END;", value: "DBMS_OUTPUT.PUT_LINE" },
  ] as const)("executes full and selected $databaseType function templates in $target", async ({ databaseType, target, value }) => {
    const sql = `@set fn = ${value};\n${target}`;
    const selectionFrom = sql.indexOf(target);
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("test"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection(databaseType));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const executeCurrentSql = vi.spyOn(useQueryStore(), "executeCurrentSql").mockResolvedValue(undefined);
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const execution = useSqlExecution({ activeTab: computed(() => activeTab.value), activeConnection: computed(() => activeConnection.value), executableSql: computed(() => sql), activeOutputView });

    await execution.tryExecute();
    await execution.tryExecute({ fullSql: sql, selectedSql: target, cursorPos: selectionFrom, selectionFrom, selectionTo: sql.length });

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledTimes(2);
    expect(executeCurrentSql).toHaveBeenNthCalledWith(1, target.replaceAll("@fn", value), { tabId: "tab-1" });
    expect(executeCurrentSql).toHaveBeenNthCalledWith(2, target.replaceAll("@fn", value), { tabId: "tab-1" });
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

  it("sends MySQL SELECT INTO user variables without opening the parameter dialog", async () => {
    const sql = `
      select project_id,
             year(date_sub(review_date, interval 1 month)),
             month(date_sub(review_date, interval 1 month))
        into @project_id, @year, @month
        from cms_dynamic_cost_review
       where id = '9f03cb27-a553-11f1-8af2-48dc2d090a1c';
    `;
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
  });

  it("executes MySQL cursor procedures with compact labels without opening the parameter dialog", async () => {
    const sql = `
      CREATE PROCEDURE process_orders()
      BEGIN
        DECLARE done INT DEFAULT FALSE;
        DECLARE order_id INT;
        DECLARE cur_orders CURSOR FOR SELECT id FROM orders;
        DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;
        OPEN cur_orders;
        read_loop:LOOP
          FETCH cur_orders INTO order_id;
          IF done THEN LEAVE read_loop; END IF;
        END LOOP read_loop;
        CLOSE cur_orders;
      END
    `;
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 };
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
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
  });

  it.each([
    {
      label: "JDBC MySQL",
      config: {
        ...connection("jdbc"),
        driver_label: "MySQL JDBC",
        connection_string: "jdbc:mysql://127.0.0.1:3306/app",
      },
    },
    {
      label: "GBase MySQL compatibility",
      config: {
        ...connection("gbase"),
        driver_profile: "gbase",
        driver_label: "GBase 8a",
      },
    },
  ])("executes $label cursor procedures from the gutter without opening the parameter dialog", async ({ config }) => {
    const sql = `CREATE PROCEDURE process_orders()
      BEGIN
        DECLARE done INT DEFAULT FALSE;
        DECLARE order_id INT;
        DECLARE cur_orders CURSOR FOR SELECT id FROM orders;
        DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;
        OPEN cur_orders;
        read_loop:LOOP
          FETCH cur_orders INTO order_id;
          IF done THEN LEAVE read_loop; END IF;
        END LOOP read_loop;
        CLOSE cur_orders;
      END`;
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(config);
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    vi.spyOn(useConnectionStore(), "refreshObjectListTreeNode").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      resolveExecutableSql: async () => sql,
      activeOutputView,
    });

    await execution.tryExecute({
      fullSql: sql,
      selectedSql: sql,
      cursorPos: 0,
      selectionFrom: 0,
      selectionTo: sql.length,
      editorViewportRequestId: 1,
    });

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1", sourceOffset: 0, onExecutionStarted: expect.any(Function) });
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
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1" });
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
      tab.results = [
        successfulResult,
        {
          columns: ["Error"],
          execution_error: true,
          error: {
            version: 1,
            code: "DBX-LEGACY-0001",
            messageKey: "backendErrors.legacy",
            messageParams: {},
            source: "legacyBackend",
            operationOutcome: "unknown",
          },
          rows: [["Duplicate entry '1'"]],
          affected_rows: 0,
          execution_time_ms: 1,
        },
      ];
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

    expect(addHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "backendErrors.unknown\n\nDuplicate entry '1'",
        affected_rows: undefined,
      }),
    );
    expect(refreshObjects).not.toHaveBeenCalled();
  });

  it("records a later PostgreSQL batch error and skips metadata refresh", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    const connectionStore = useConnectionStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      const tab = activeTab.value;
      if (!tab) return;
      const successfulResult = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      tab.result = successfulResult;
      tab.results = [successfulResult, { columns: ["Error"], execution_error: true, rows: [["relation missing_table does not exist"]], affected_rows: 0, execution_time_ms: 1 }];
      tab.activeResultIndex = 0;
    });
    const addHistory = vi.spyOn(historyStore, "add").mockResolvedValue(undefined);
    const refreshObjects = vi.spyOn(connectionStore, "refreshObjectListTreeNode").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "BEGIN; SELECT 1 AS value; SELECT * FROM missing_table"),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(addHistory).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: "relation missing_table does not exist", affected_rows: undefined }));
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

  it("continues to record explicitly marked non-MySQL errors as failures", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["Error"], rows: [["relation does not exist"]], affected_rows: 0, execution_time_ms: 1, execution_error: true };
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

  it("does not treat an unmarked PostgreSQL Error alias as a failure", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["Error"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 };
    });
    const addHistory = vi.spyOn(historyStore, "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "SELECT 2 AS Error"),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(addHistory).toHaveBeenCalledWith(expect.objectContaining({ success: true, error: undefined }));
  });

  it("cancels the editor viewport request when dangerous SQL is dismissed", async () => {
    const sql = "DELETE FROM users WHERE id = 7";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql");
    const onExecutionCancelled = vi.fn();

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
      onExecutionCancelled,
    });

    await execution.tryExecute({
      fullSql: sql,
      selectedSql: sql,
      cursorPos: 0,
      selectionFrom: 0,
      selectionTo: sql.length,
      editorViewportRequestId: 17,
    });

    expect(execution.showDangerDialog.value).toBe(true);
    execution.showDangerDialog.value = false;
    await nextTick();

    expect(onExecutionCancelled).toHaveBeenCalledTimes(1);
    expect(onExecutionCancelled).toHaveBeenCalledWith(17);
    expect(executeCurrentSql).not.toHaveBeenCalled();
  });

  it("does not reuse a cancelled viewport request on the next dangerous execution", async () => {
    const sql = "DELETE FROM users WHERE id = 7";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const ownership = createQueryEditorExecutionViewportOwnership();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async (_sql, options) => {
      options?.onExecutionStarted?.();
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const onExecutionStarted = vi.fn((requestId: number) => ownership.acceptRequest(requestId));
    const onExecutionCancelled = vi.fn((requestId: number) => ownership.cancelPendingRequest(requestId));

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
      onExecutionStarted,
      onExecutionCancelled,
    });

    const snapshotFor = (editorViewportRequestId: number) => ({
      fullSql: sql,
      selectedSql: sql,
      cursorPos: 0,
      selectionFrom: 0,
      selectionTo: sql.length,
      editorViewportRequestId,
    });
    const firstRequestId = ownership.beginRequest();
    await execution.tryExecute(snapshotFor(firstRequestId));
    expect(execution.showDangerDialog.value).toBe(true);

    execution.showDangerDialog.value = false;
    await nextTick();

    expect(onExecutionCancelled).toHaveBeenCalledTimes(1);
    expect(onExecutionCancelled).toHaveBeenCalledWith(firstRequestId);
    expect(ownership.acceptRequest(firstRequestId)).toBe(false);

    const secondRequestId = ownership.beginRequest();
    await execution.tryExecute(snapshotFor(secondRequestId));
    expect(execution.showDangerDialog.value).toBe(true);

    await execution.onDangerConfirm();

    expect(onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(onExecutionStarted).toHaveBeenCalledWith(secondRequestId);
    expect(ownership.consumeCompletionPreservation()).toBe(true);
    expect(ownership.consumeCompletionPreservation()).toBe(false);
    expect(executeCurrentSql).toHaveBeenCalledTimes(1);
  });

  it("keeps the full dangerous script and new-result-tab intent through confirmation", async () => {
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

    await execution.tryExecuteInNewResultTab();

    expect(execution.showDangerDialog.value).toBe(true);
    expect(execution.pendingDangerSql.value).toBe(sql);
    expect(executeCurrentSql).not.toHaveBeenCalled();

    await execution.onDangerConfirm();

    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1", openInNewResultTab: true });
  });

  it("settles a failed execution after accepting a dangerous-SQL dialog", async () => {
    const sql = "DELETE FROM users WHERE id = 7";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    vi.spyOn(useQueryStore(), "executeCurrentSql").mockRejectedValue(new Error("connection lost"));
    const onDeferredExecutionSettled = vi.fn();

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
      onDeferredExecutionSettled,
    });

    await execution.tryExecute();
    await execution.onDangerConfirm();

    expect(onDeferredExecutionSettled).toHaveBeenCalledWith({ status: "started", ok: false, errorMessage: "connection lost", tabId: "tab-1" });
  });

  it("keeps the active retained result when a new-result dangerous prompt is cancelled", async () => {
    const result = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    const activeTab = ref<QueryTab | undefined>({
      ...queryTab("app"),
      result,
      resultRuns: [{ id: "run-1", title: "Run 1", sequence: 1, sql: "SELECT 1", createdAt: 1, result }],
      activeResultRunId: "run-1",
    });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql");

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "DROP TABLE users"),
      activeOutputView,
    });

    await execution.tryExecuteInNewResultTab();
    expect(execution.showDangerDialog.value).toBe(true);

    execution.showDangerDialog.value = false;
    await Promise.resolve();

    expect(executeCurrentSql).not.toHaveBeenCalled();
    expect(activeTab.value?.activeResultRunId).toBe("run-1");
    expect(activeTab.value?.result).toEqual(result);
  });

  it("uses the inferred Oracle dialect when explaining through custom JDBC", async () => {
    const sql = "SELECT * FROM DUAL";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("ORCL"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>({
      ...connection("jdbc"),
      connection_string: "jdbc:oracle:thin:@127.0.0.1:1521:ORCL",
      jdbc_driver_class: "oracle.jdbc.OracleDriver",
    });
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const explainTabSql = vi.spyOn(queryStore, "explainTabSql").mockResolvedValue({ ok: true, sql });

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExplain();

    expect(explainTabSql).toHaveBeenCalledWith("tab-1", sql, "oracle", "explain");
  });

  it("explains the resolved PostgreSQL statement after SQL parameter input", async () => {
    const sql = "SELECT :var;";
    const resolvedSql = "SELECT 123;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const explainTabSql = vi.spyOn(queryStore, "explainTabSql").mockResolvedValue({ ok: true, sql: resolvedSql });

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExplain();

    expect(execution.showSqlParameterDialog.value).toBe(true);
    expect(execution.sqlParameterNames.value.map((parameter) => parameter.name)).toEqual(["var"]);
    expect(explainTabSql).not.toHaveBeenCalled();

    await execution.onSqlParametersConfirm(resolvedSql);

    expect(explainTabSql).toHaveBeenCalledWith("tab-1", resolvedSql, "postgres", "explain");
  });

  it("explains the analyzed PostgreSQL statement after SQL parameter input", async () => {
    const sql = "SELECT :var;";
    const resolvedSql = "SELECT 123;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const explainTabSql = vi.spyOn(queryStore, "explainTabSql").mockResolvedValue({ ok: true, sql: resolvedSql });

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });
    execution.explainMode.value = "autotrace";

    await execution.tryExplain();

    expect(execution.showSqlParameterDialog.value).toBe(true);
    expect(explainTabSql).not.toHaveBeenCalled();

    await execution.onSqlParametersConfirm(resolvedSql);

    expect(explainTabSql).toHaveBeenCalledWith("tab-1", resolvedSql, "postgres", "autotrace");
  });

  it("explains the string-parameter statement with the dialog's escaped substitution", async () => {
    const sql = "SELECT :name;";
    const resolvedSql = "SELECT 'O''Reilly';";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const explainTabSql = vi.spyOn(queryStore, "explainTabSql").mockResolvedValue({ ok: true, sql: resolvedSql });

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExplain();

    expect(execution.showSqlParameterDialog.value).toBe(true);

    await execution.onSqlParametersConfirm(resolvedSql);

    expect(explainTabSql).toHaveBeenCalledWith("tab-1", resolvedSql, "postgres", "explain");
  });

  it("explains a PostgreSQL cast statement without opening the parameter dialog", async () => {
    const sql = "SELECT '1'::int;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const explainTabSql = vi.spyOn(queryStore, "explainTabSql").mockResolvedValue({ ok: true, sql });

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExplain();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(explainTabSql).toHaveBeenCalledWith("tab-1", sql, "postgres", "explain");
  });

  it("explains a parameter-free statement without opening the parameter dialog", async () => {
    const sql = "SELECT * FROM orders;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const explainTabSql = vi.spyOn(queryStore, "explainTabSql").mockResolvedValue({ ok: true, sql });

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExplain();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(explainTabSql).toHaveBeenCalledWith("tab-1", sql, "postgres", "explain");
  });

  it("keeps the new-result-tab intent through Redis command confirmation", async () => {
    const sql = "DEL user:1";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("0"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("redis"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
      blockDangerousRedisCommands: ref(true),
    });

    await execution.tryExecuteInNewResultTab();

    expect(execution.showDangerDialog.value).toBe(true);
    expect(executeCurrentSql).not.toHaveBeenCalled();

    await execution.onDangerConfirm();

    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1", skipRedisSafetyCheck: false, openInNewResultTab: true });
  });

  it("executes Redis batches with comment lines when the dangerous-command guard is on by default", async () => {
    const sql = "# warm the cache\nGET user:1\n-- then ping\nPING";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("0"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("redis"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    // A comment line never reaches the safety pre-scan, so a safe batch is not
    // blocked by the fail-closed classifier.
    expect(execution.showDangerDialog.value).toBe(false);
    expect(executeCurrentSql).toHaveBeenCalledTimes(1);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { tabId: "tab-1", skipRedisSafetyCheck: false });
  });

  it("keeps an explicitly selected Redis console visible for multi-command execution", async () => {
    const sql = "GET user:1\nDBSIZE";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("0"), sql, uiState: { redisResultViewMode: "console" } });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("redis"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("summary");
    const queryStore = useQueryStore();
    useSettingsStore().editorSettings.multiStatementDefaultView = "summary";
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["result"], rows: [["value"]], affected_rows: 0, execution_time_ms: 1, redis_console_output: "value" };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("result");
  });

  it("distinguishes read-only and mutating Meilisearch REST requests", () => {
    expect(isDangerousSql("GET /health", "meilisearch")).toBe(false);
    expect(isDangerousSql('POST /indexes/movies/documents/fetch\n{"limit":10}', "meilisearch")).toBe(false);
    expect(isDangerousSql('POST /indexes/movies/search\n{"q":"space"}', "meilisearch")).toBe(false);
    expect(isDangerousSql('POST /indexes\n{"uid":"movies"}', "meilisearch")).toBe(true);
    expect(isDangerousSql("PUT /indexes/movies/settings", "meilisearch")).toBe(true);
    expect(isDangerousSql("DELETE /indexes/movies/documents/001", "meilisearch")).toBe(true);
  });

  it("treats Elasticsearch PATCH requests as mutating", () => {
    expect(isDangerousSql('PATCH /products/_settings\n{"index":{"refresh_interval":"5s"}}', "elasticsearch")).toBe(true);
    expect(isDangerousSql('PATCH /products/_settings\n{"index":{"refresh_interval":"5s"}}', "easysearch")).toBe(true);
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
    await vi.waitFor(() => {
      expect(productionSafetyStore.pending?.sql).toContain("UPDATE users");
    });
    expect(executeCurrentSql).not.toHaveBeenCalled();

    productionSafetyStore.confirm();
    await pendingExecution;
    expect(executeCurrentSql).toHaveBeenCalledTimes(1);
  });

  describe("mode-dependent substitution variable prompt overrides", () => {
    it("openGauss A-mode disables substitution -> saved/reloaded -> does not prompt parameter dialog on &var", async () => {
      const sql = "SELECT * FROM t WHERE col = &var;";
      const activeTab = ref<QueryTab | undefined>({ ...queryTab("demo"), sql });
      const activeConnection = ref<ConnectionConfig | undefined>(connection("opengauss"));
      const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
      const queryStore = useQueryStore();
      const connectionStore = useConnectionStore();
      const settingsStore = useSettingsStore();

      connectionStore.connections = [activeConnection.value!];
      queryStore.tabs = [activeTab.value!];
      queryStore.activeTabId = activeTab.value!.id;
      const modeSpy = vi.spyOn(connectionStore, "databaseCompatibilityMode").mockReturnValue("A");

      const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
        if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      });
      vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

      // Verify that by default in A-mode, &var triggers parameter prompt
      const defaultExecution = useSqlExecution({
        activeTab: computed(() => activeTab.value),
        activeConnection: computed(() => activeConnection.value),
        executableSql: computed(() => sql),
        activeOutputView,
      });
      await defaultExecution.tryExecute();
      expect(defaultExecution.showSqlParameterDialog.value).toBe(true);
      expect(defaultExecution.sqlParameterNames.value.map((p) => p.name)).toEqual(["var"]);

      // User disables substitution for openGauss in settings UI
      const initialOverrides = updateSqlVariableSyntaxToggle({}, "opengauss", "substitution", false, "A");
      settingsStore.updateEditorSettings({
        sqlVariableSyntaxOverrides: initialOverrides,
      });
      expect(settingsStore.editorSettings.sqlVariableSyntaxOverrides.opengauss?.substitution).toBe(false);

      // Realistic settings interaction while connected to B-mode:
      // The current connection is in B-mode, where substitution defaults to false.
      // User only toggles shell=false in settings.
      modeSpy.mockReturnValue("B");
      const toggledInB = updateSqlVariableSyntaxToggle(settingsStore.editorSettings.sqlVariableSyntaxOverrides, "opengauss", "shell", false, "B");
      settingsStore.updateEditorSettings({
        sqlVariableSyntaxOverrides: toggledInB,
      });
      // The explicit false substitution override must NOT be dropped, even though current mode was B
      expect(settingsStore.editorSettings.sqlVariableSyntaxOverrides.opengauss).toEqual({
        substitution: false,
        shell: false,
      });

      // Switch back to A-mode and execute -> must NOT prompt parameter dialog
      modeSpy.mockReturnValue("A");
      const execution = useSqlExecution({
        activeTab: computed(() => activeTab.value),
        activeConnection: computed(() => activeConnection.value),
        executableSql: computed(() => sql),
        activeOutputView,
      });
      await execution.tryExecute();
      expect(execution.showSqlParameterDialog.value).toBe(false);
      expect(executeCurrentSql).toHaveBeenCalledWith(sql, expect.anything());
    });

    it("Kingbase Oracle mode disables substitution -> UI toggles shell in pg mode -> reloads in oracle mode -> does not prompt parameter dialog on &var", async () => {
      const sql = "SELECT * FROM t WHERE col = &var;";
      const activeTab = ref<QueryTab | undefined>({ ...queryTab("demo"), sql });
      const activeConnection = ref<ConnectionConfig | undefined>({
        ...connection("kingbase"),
        database_info: { compatibilityMode: "oracle" },
      });
      const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
      const queryStore = useQueryStore();
      const connectionStore = useConnectionStore();
      const settingsStore = useSettingsStore();

      connectionStore.connections = [activeConnection.value!];
      queryStore.tabs = [activeTab.value!];
      queryStore.activeTabId = activeTab.value!.id;

      const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
        if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      });
      vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

      // Verify that by default in Kingbase oracle mode, &var triggers parameter prompt
      const defaultExecution = useSqlExecution({
        activeTab: computed(() => activeTab.value),
        activeConnection: computed(() => activeConnection.value),
        executableSql: computed(() => sql),
        activeOutputView,
      });
      await defaultExecution.tryExecute();
      expect(defaultExecution.showSqlParameterDialog.value).toBe(true);

      // User disables substitution for Kingbase in settings UI
      const initialOverrides = updateSqlVariableSyntaxToggle({}, "kingbase", "substitution", false, "oracle");
      settingsStore.updateEditorSettings({
        sqlVariableSyntaxOverrides: initialOverrides,
      });
      expect(settingsStore.editorSettings.sqlVariableSyntaxOverrides.kingbase?.substitution).toBe(false);

      // Realistic settings interaction while connected to pg mode:
      // Current connection is in pg mode (where substitution defaults to false).
      // User only toggles shell=false in settings.
      activeConnection.value = {
        ...activeConnection.value!,
        database_info: { compatibilityMode: "pg" },
      };
      const toggledInPg = updateSqlVariableSyntaxToggle(settingsStore.editorSettings.sqlVariableSyntaxOverrides, "kingbase", "shell", false, "pg");
      settingsStore.updateEditorSettings({
        sqlVariableSyntaxOverrides: toggledInPg,
      });
      // Explicit substitution: false must NOT be dropped
      expect(settingsStore.editorSettings.sqlVariableSyntaxOverrides.kingbase).toEqual({
        substitution: false,
        shell: false,
      });

      // Switch back to oracle mode and execute -> must NOT prompt parameter dialog
      activeConnection.value = {
        ...activeConnection.value!,
        database_info: { compatibilityMode: "oracle" },
      };
      const execution = useSqlExecution({
        activeTab: computed(() => activeTab.value),
        activeConnection: computed(() => activeConnection.value),
        executableSql: computed(() => sql),
        activeOutputView,
      });
      await execution.tryExecute();
      expect(execution.showSqlParameterDialog.value).toBe(false);
      expect(executeCurrentSql).toHaveBeenCalledWith(sql, expect.anything());
    });

    it("Kingbase explicitly enables substitution -> UI toggles shell in oracle mode -> executes in pg mode -> prompts parameter dialog on &var", async () => {
      const sql = "SELECT * FROM t WHERE col = &var;";
      const activeTab = ref<QueryTab | undefined>({ ...queryTab("demo"), sql });
      const activeConnection = ref<ConnectionConfig | undefined>({
        ...connection("kingbase"),
        database_info: { compatibilityMode: "oracle" },
      });
      const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
      const queryStore = useQueryStore();
      const connectionStore = useConnectionStore();
      const settingsStore = useSettingsStore();

      connectionStore.connections = [activeConnection.value!];
      queryStore.tabs = [activeTab.value!];
      queryStore.activeTabId = activeTab.value!.id;

      const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
        if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      });
      vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

      // User explicitly enables substitution for Kingbase (sets substitution=true)
      const initialOverrides = updateSqlVariableSyntaxToggle({}, "kingbase", "substitution", true, "oracle");
      settingsStore.updateEditorSettings({
        sqlVariableSyntaxOverrides: initialOverrides,
      });
      expect(settingsStore.editorSettings.sqlVariableSyntaxOverrides.kingbase?.substitution).toBe(true);

      // While in oracle mode (where substitution default is already true), user toggles shell=false
      const toggledInOracle = updateSqlVariableSyntaxToggle(settingsStore.editorSettings.sqlVariableSyntaxOverrides, "kingbase", "shell", false, "oracle");
      settingsStore.updateEditorSettings({
        sqlVariableSyntaxOverrides: toggledInOracle,
      });
      // Explicit substitution: true must be preserved
      expect(settingsStore.editorSettings.sqlVariableSyntaxOverrides.kingbase).toEqual({
        substitution: true,
        shell: false,
      });

      // Switch to pg mode (where default is false) and execute -> MUST prompt parameter dialog because explicit true was preserved
      activeConnection.value = {
        ...activeConnection.value!,
        database_info: { compatibilityMode: "pg" },
      };
      const execution = useSqlExecution({
        activeTab: computed(() => activeTab.value),
        activeConnection: computed(() => activeConnection.value),
        executableSql: computed(() => sql),
        activeOutputView,
      });
      await execution.tryExecute();
      expect(execution.showSqlParameterDialog.value).toBe(true);
      expect(execution.sqlParameterNames.value.map((p) => p.name)).toEqual(["var"]);
      expect(executeCurrentSql).not.toHaveBeenCalled();
    });

    it("PostgreSQL bitwise & and array overlap && do not prompt by default, but prompt when explicitly enabled", async () => {
      const sqlBitwise = "SELECT flags &mask FROM t;";
      const sqlArrayOverlap = "SELECT a &&b FROM t;";
      const activeTab = ref<QueryTab | undefined>({ ...queryTab("public"), sql: sqlBitwise });
      const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
      const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
      const queryStore = useQueryStore();
      const connectionStore = useConnectionStore();
      const settingsStore = useSettingsStore();

      connectionStore.connections = [activeConnection.value!];
      queryStore.tabs = [activeTab.value!];
      queryStore.activeTabId = activeTab.value!.id;

      const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
        if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      });
      vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

      // Default: no prompt for PostgreSQL bitwise &
      const executionBitwise = useSqlExecution({
        activeTab: computed(() => activeTab.value),
        activeConnection: computed(() => activeConnection.value),
        executableSql: computed(() => sqlBitwise),
        activeOutputView,
      });
      await executionBitwise.tryExecute();
      expect(executionBitwise.showSqlParameterDialog.value).toBe(false);

      // Default: no prompt for PostgreSQL array overlap &&
      activeTab.value = { ...queryTab("public"), sql: sqlArrayOverlap };
      const executionArray = useSqlExecution({
        activeTab: computed(() => activeTab.value),
        activeConnection: computed(() => activeConnection.value),
        executableSql: computed(() => sqlArrayOverlap),
        activeOutputView,
      });
      await executionArray.tryExecute();
      expect(executionArray.showSqlParameterDialog.value).toBe(false);

      // Explicitly enable substitution for postgres
      settingsStore.updateEditorSettings({
        sqlVariableSyntaxOverrides: normalizeSqlVariableSyntaxOverrides({ postgres: { substitution: true } }),
      });
      expect(settingsStore.editorSettings.sqlVariableSyntaxOverrides.postgres?.substitution).toBe(true);

      const sqlWithVar = "SELECT * FROM t WHERE col = &var;";
      activeTab.value = { ...queryTab("public"), sql: sqlWithVar };
      const executionExplicit = useSqlExecution({
        activeTab: computed(() => activeTab.value),
        activeConnection: computed(() => activeConnection.value),
        executableSql: computed(() => sqlWithVar),
        activeOutputView,
      });
      await executionExplicit.tryExecute();
      expect(executionExplicit.showSqlParameterDialog.value).toBe(true);
      expect(executionExplicit.sqlParameterNames.value.map((p) => p.name)).toEqual(["var"]);
      expect(executeCurrentSql).toHaveBeenCalledTimes(2);
    });
  });
});

describe("snapshotResultForMerge", () => {
  it("stays intact after the store releases the live payload in place", () => {
    const live = {
      columns: ["id", "amount"],
      rows: [
        [1, 10],
        [2, 20],
      ],
      column_types: ["INT", "DECIMAL"],
      affected_rows: 2,
      execution_time_ms: 5,
    };
    const snapshot = snapshotResultForMerge(live as never)!;

    // Mirrors queryStore.releaseResultObjectPayload: the arrays the merged view
    // reads are detached, so clearing the live result must not empty them.
    live.columns = [];
    live.rows = [];

    expect(snapshot.columns).toEqual(["id", "amount"]);
    expect(snapshot.rows).toEqual([
      [1, 10],
      [2, 20],
    ]);
    expect(snapshot.column_types).toEqual(["INT", "DECIMAL"]);
  });

  it("passes undefined through", () => {
    expect(snapshotResultForMerge(undefined)).toBeUndefined();
  });
});
