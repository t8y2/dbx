// @vitest-environment happy-dom

import { createApp, h, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DatabaseBrowser from "../DatabaseBrowser.vue";
import type { ConnectionConfig } from "@/types/database";
import { filterSchemaNamesForConnection } from "@/lib/database/visibleDatabases";

const testSchemas = [
  { name: "APP", comment: "Application Schema" },
  { name: "HR", comment: null },
  { name: "SALES", comment: "Sales Schema" },
];

const testDatabases = [{ name: "db_mysql", size_bytes: 1024, created_at: null, updated_at: null, comment: null, default_charset: "utf8mb4", default_collation: "utf8mb4_0900_ai_ci" }];
const schemaChoicesRevision = ref(0);

const mocks = vi.hoisted(() => ({
  listDatabases: vi.fn(),
  listDatabaseMetadata: vi.fn(),
  listSchemaInfos: vi.fn(),
  listSchemas: vi.fn(),
  readVisibleSchemaSelection: vi.fn(),
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
    completionCacheRevision: () => schemaChoicesRevision.value,
    readVisibleSchemaSelection: (...args: unknown[]) => mocks.readVisibleSchemaSelection(...args),
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
    schemaChoicesRevision.value = 0;
    mocks.listDatabases.mockResolvedValue(testDatabases);
    mocks.listDatabaseMetadata.mockResolvedValue([]);
    mocks.listSchemaInfos.mockResolvedValue(testSchemas);
    mocks.listSchemas.mockResolvedValue(testSchemas.map((s) => s.name));
    mocks.readVisibleSchemaSelection.mockImplementation(async (id: string, database: string) => {
      const infos = await mocks.listSchemaInfos(id, database, true);
      return { infos, visibleNames: infos.map((schema: { name: string }) => schema.name) };
    });
    mocks.openObjectBrowser.mockReturnValue("tab-1");
  });

  afterEach(() => {
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;
    vi.clearAllMocks();
  });

  it("shows the shared selected system range with the old toggle off and reacts to scope edits", async () => {
    const target = reactive({ id: "selected-system", name: "Oracle", db_type: "oracle", database: "XE", show_system_schemas: false, visible_schemas: { XE: ["SYS"] } } as ConnectionConfig);
    mocks.listSchemaInfos.mockImplementation(async (_id, _database, system) => {
      return (system ? ["APP", "SYS"] : ["APP"]).map((name) => ({ name, comment: null }));
    });
    mocks.readVisibleSchemaSelection.mockImplementation(async (id: string, database: string) => {
      const infos = await mocks.listSchemaInfos(id, database, true);
      return {
        infos,
        visibleNames: filterSchemaNamesForConnection(
          infos.map((schema: { name: string }) => schema.name),
          target,
          database,
        ),
      };
    });
    mocks.listSchemas.mockImplementation(async (_id, _database, _filter, system) => (system ? ["APP", "SYS"] : ["APP"]));
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({ render: () => h(DatabaseBrowser, { connection: target }) });
    app.mount(host);
    const names = () => [...host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")].map((row) => row.textContent?.trim());
    await vi.waitFor(() => expect(names()).toEqual(["SYS"]));
    expect(mocks.readVisibleSchemaSelection).toHaveBeenCalledWith(target.id, "XE", true);
    target.visible_schemas = { XE: ["APP"] };
    await vi.waitFor(() => expect(names()).toEqual(["APP"]));
    target.visible_schemas = { XE: [] };
    await vi.waitFor(() => expect(names()).toEqual([]));
    const requests = mocks.listSchemaInfos.mock.calls.length;
    target.visible_schemas = { XE: [], archive: ["HISTORY"] };
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.listSchemaInfos).toHaveBeenCalledTimes(requests);
  });

  it("refreshes ordinary discoveries when a root selection save keeps the same empty overrides", async () => {
    const connection = { id: "fresh-ordinary", name: "Oracle", db_type: "oracle", database: "XE", schema_visibility: { migrate_legacy: false, databases: { XE: {} } } } as ConnectionConfig;
    mocks.listSchemaInfos.mockResolvedValueOnce([{ name: "APP" }]).mockResolvedValue([{ name: "APP" }, { name: "NEW_APP" }]);
    host = document.createElement("div");
    document.body.append(host);
    app = createApp(DatabaseBrowser, { connection });
    app.mount(host);
    const rows = () => [...host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")].map((row) => row.textContent?.trim());
    await vi.waitFor(() => expect(rows()).toEqual(["APP"]));
    schemaChoicesRevision.value++;
    await vi.waitFor(() => expect(rows()).toEqual(["APP", "NEW_APP"]));
    expect(mocks.readVisibleSchemaSelection).toHaveBeenCalledTimes(2);
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
      expect(mocks.listSchemaInfos).toHaveBeenCalledWith(oracleJdbcConnection.id, "", true);
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
      expect(mocks.listSchemaInfos).toHaveBeenCalledWith(nativeOracleConnection.id, "", true);
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(testSchemas.length);
    });
  });

  it("reports a failed shared read without substituting another enumeration", async () => {
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
      expect(host!.textContent).toContain("databaseBrowser.loadFailed");
      expect(mocks.listSchemas).not.toHaveBeenCalled();
      expect(mocks.listDatabases).not.toHaveBeenCalled();
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
      expect(mocks.listSchemaInfos).toHaveBeenCalledWith(damengJdbcConnection.id, "", true);
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(testSchemas.length);
    });
  });

  it("keeps a successful empty Schema list empty instead of substituting databases", async () => {
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
      expect(mocks.listSchemaInfos).toHaveBeenCalledWith(oracleJdbcConnection.id, "", true);
      expect(mocks.listDatabases).not.toHaveBeenCalled();
      expect(host!.querySelectorAll(".contents > .flex.items-center.text-\\[13px\\]")).toHaveLength(0);
    });
  });
});
