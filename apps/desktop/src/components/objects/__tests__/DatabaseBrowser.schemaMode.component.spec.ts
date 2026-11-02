// @vitest-environment happy-dom

import { createApp, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DatabaseBrowser from "../DatabaseBrowser.vue";
import type { ConnectionConfig } from "@/types/database";

const testSchemas = [
  { name: "APP", comment: "Application Schema" },
  { name: "HR", comment: null },
  { name: "SALES", comment: "Sales Schema" },
];

const testDatabases = [{ name: "db_mysql", size_bytes: 1024, created_at: null, updated_at: null, comment: null, default_charset: "utf8mb4", default_collation: "utf8mb4_0900_ai_ci" }];

const mocks = vi.hoisted(() => ({
  listDatabases: vi.fn(),
  listDatabaseMetadata: vi.fn(),
  listSchemaInfos: vi.fn(),
  listSchemas: vi.fn(),
  openObjectBrowser: vi.fn(),
  editorSettings: {
    objectBrowserViewMode: "list" as "list" | "grid" | "compact",
    objectBrowserCompactWidth: 160,
  },
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: (...args: unknown[]) => mocks.listDatabases(...args),
  listDatabaseMetadata: (...args: unknown[]) => mocks.listDatabaseMetadata(...args),
  listSchemaInfos: (...args: unknown[]) => mocks.listSchemaInfos(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    setDefaultDatabase: vi.fn(),
    clearDefaultDatabase: vi.fn(),
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    openObjectBrowser: (...args: unknown[]) => mocks.openObjectBrowser(...args),
    createTab: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: mocks.editorSettings,
    updateEditorSettings: (patch: Partial<typeof mocks.editorSettings>) => {
      Object.assign(mocks.editorSettings, patch);
    },
  }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: { value: "en-US" },
  }),
}));

vi.mock("@/components/sidebar/SidebarTreeRuntimeHost.vue", () => ({
  default: {
    setup() {
      return () => null;
    },
  },
}));

vi.mock("@/components/sidebar/SidebarTreeItemDialogs.vue", () => ({
  default: {
    setup() {
      return () => null;
    },
  },
}));

vi.mock("@/composables/useToolbarOverflow", () => ({
  useToolbarOverflow: () => ({
    tier: { value: 0 },
  }),
}));

describe("DatabaseBrowser connection-root schema mode (#13646)", () => {
  let app: App | undefined;
  let host: HTMLElement | undefined;

  beforeEach(() => {
    mocks.listDatabases.mockResolvedValue(testDatabases);
    mocks.listDatabaseMetadata.mockResolvedValue([]);
    mocks.listSchemaInfos.mockResolvedValue(testSchemas);
    mocks.listSchemas.mockResolvedValue(testSchemas.map((s) => s.name));
    mocks.openObjectBrowser.mockReturnValue("tab-1");
  });

  afterEach(() => {
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;
    vi.clearAllMocks();
  });

  it("loads and displays schemas for Oracle JDBC connection (#13646)", async () => {
    const oracleJdbcConnection: ConnectionConfig = {
      id: "conn-oracle-jdbc",
      name: "Oracle 11g JDBC",
      db_type: "jdbc",
      connection_string: "jdbc:oracle:thin:@127.0.0.1:1521:xe",
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection: oracleJdbcConnection });
    app.mount(host);

    await vi.waitFor(() => {
      expect(mocks.listSchemaInfos).toHaveBeenCalledWith(oracleJdbcConnection.id, "");
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(testSchemas.length);
    });

    // Does not call listDatabases for connection-root schema connections
    expect(mocks.listDatabases).not.toHaveBeenCalled();

    // Verify row names
    const renderedNames = Array.from(host.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).map((el) => el.textContent?.trim());
    expect(renderedNames).toEqual(["APP", "HR", "SALES"]);

    // Double-clicking a row opens object browser with both database and schema
    const firstRow = host.querySelector<HTMLElement>(".grid.h-\\[34px\\]")!;
    firstRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(mocks.openObjectBrowser).toHaveBeenCalledWith(oracleJdbcConnection.id, "APP", "APP");
  });

  it("loads and displays schemas for native Oracle connection", async () => {
    const nativeOracleConnection: ConnectionConfig = {
      id: "conn-oracle-native",
      name: "Oracle Native",
      db_type: "oracle",
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection: nativeOracleConnection });
    app.mount(host);

    await vi.waitFor(() => {
      expect(mocks.listSchemaInfos).toHaveBeenCalledWith(nativeOracleConnection.id, "");
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(testSchemas.length);
    });
  });

  it("falls back to listSchemas when listSchemaInfos rejects", async () => {
    mocks.listSchemaInfos.mockRejectedValueOnce(new Error("listSchemaInfos unsupported"));
    mocks.listSchemas.mockResolvedValueOnce(["SCHEMA_1", "SCHEMA_2"]);

    const oracleJdbcConnection: ConnectionConfig = {
      id: "conn-oracle-jdbc",
      name: "Oracle JDBC",
      db_type: "jdbc",
      jdbc_driver_class: "oracle.jdbc.OracleDriver",
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection: oracleJdbcConnection });
    app.mount(host);

    await vi.waitFor(() => {
      expect(mocks.listSchemaInfos).toHaveBeenCalledWith(oracleJdbcConnection.id, "");
      expect(mocks.listSchemas).toHaveBeenCalledWith(oracleJdbcConnection.id, "", true);
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(2);
    });
  });

  it("calls listDatabases for MySQL connections and does not call listSchemaInfos", async () => {
    const mysqlConnection: ConnectionConfig = {
      id: "conn-mysql",
      name: "MySQL 8.0",
      db_type: "mysql",
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection: mysqlConnection });
    app.mount(host);

    await vi.waitFor(() => {
      expect(mocks.listDatabases).toHaveBeenCalledWith(mysqlConnection.id);
      expect(mocks.listSchemaInfos).not.toHaveBeenCalled();
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(testDatabases.length);
    });

    const firstRow = host.querySelector<HTMLElement>(".grid.h-\\[34px\\]")!;
    firstRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(mocks.openObjectBrowser).toHaveBeenCalledWith(mysqlConnection.id, "db_mysql", undefined);
  });

  it("includes system schemas when show_system_schemas is true", async () => {
    mocks.listSchemaInfos.mockResolvedValueOnce([
      { name: "APP", comment: null },
      { name: "SYSTEM", comment: null },
    ]);

    const oracleConnection: ConnectionConfig = {
      id: "conn-oracle-sys",
      name: "Oracle with System Schemas",
      db_type: "oracle",
      show_system_schemas: true,
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection: oracleConnection });
    app.mount(host);

    await vi.waitFor(() => {
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(2);
    });
    const renderedNames = Array.from(host.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).map((el) => el.textContent?.trim());
    expect(renderedNames).toEqual(["APP", "SYSTEM"]);
  });

  it("supports Dameng JDBC connections", async () => {
    const damengJdbcConnection: ConnectionConfig = {
      id: "conn-dm-jdbc",
      name: "Dameng DM8 JDBC",
      db_type: "jdbc",
      connection_string: "jdbc:dm://127.0.0.1:5236",
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection: damengJdbcConnection });
    app.mount(host);

    await vi.waitFor(() => {
      expect(mocks.listSchemaInfos).toHaveBeenCalledWith(damengJdbcConnection.id, "");
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(testSchemas.length);
    });
  });

  it("falls back to listDatabases when schemas return empty list", async () => {
    mocks.listSchemaInfos.mockResolvedValueOnce([]);
    mocks.listDatabases.mockResolvedValueOnce([{ name: "FALLBACK_SCHEMA", size_bytes: null, created_at: null, updated_at: null, comment: null, default_charset: null, default_collation: null }]);

    const oracleJdbcConnection: ConnectionConfig = {
      id: "conn-oracle-empty-schemas",
      name: "Oracle JDBC Fallback",
      db_type: "jdbc",
      connection_string: "jdbc:oracle:thin:@127.0.0.1:1521:xe",
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection: oracleJdbcConnection });
    app.mount(host);

    await vi.waitFor(() => {
      expect(mocks.listSchemaInfos).toHaveBeenCalledWith(oracleJdbcConnection.id, "");
      expect(mocks.listDatabases).toHaveBeenCalledWith(oracleJdbcConnection.id);
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(1);
    });
  });
});
