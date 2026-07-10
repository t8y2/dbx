import { computed, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiresDatabaseSelection, useSqlExecution } from "../useSqlExecution";
import { useHistoryStore } from "@/stores/historyStore";
import { useQueryStore } from "@/stores/queryStore";
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

  it("allows MySQL CREATE SCHEMA with options to run without a selected database", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE SCHEMA `app-db` DEFAULT CHARACTER SET utf8mb4")).toBe(false);
  });

  it("allows MySQL install batches that switch databases before table DDL", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db; USE app_db; CREATE TABLE users(id INT PRIMARY KEY)")).toBe(false);
  });

  it("allows MySQL install batches with session setup before switching databases", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "SET NAMES utf8mb4; DROP DATABASE IF EXISTS app_db; CREATE DATABASE app_db; USE app_db; INSERT INTO users VALUES (1)")).toBe(false);
  });

  it("requires a database when MySQL batch statements never establish database context", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db; CREATE TABLE users(id INT)")).toBe(true);
  });

  it("requires a database when a USE statement is not a standalone database switch", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "CREATE DATABASE app_db; USE app_db SELECT 1; CREATE TABLE users(id INT)")).toBe(true);
  });

  it("still requires a database for ordinary MySQL queries", () => {
    expect(requiresDatabaseSelection(queryTab(), connection("mysql"), "SELECT * FROM users")).toBe(true);
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
});
