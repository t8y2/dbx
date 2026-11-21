// @vitest-environment happy-dom

import { createApp, h, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DatabaseBrowser from "../DatabaseBrowser.vue";
import type { ConnectionConfig } from "@/types/database";

const connection: ConnectionConfig = {
  id: "conn-mysql",
  name: "MySQL",
  db_type: "mysql",
};

const databaseRow = {
  name: "db_mysql",
  size_bytes: 1024,
  created_at: null,
  updated_at: null,
  comment: null,
  default_charset: "utf8mb4",
  default_collation: "utf8mb4_0900_ai_ci",
};

const alterSql = "ALTER DATABASE `db_mysql` DEFAULT CHARACTER SET gbk COLLATE gbk_chinese_ci";

const mocks = vi.hoisted(() => ({
  listDatabases: vi.fn(),
  listDatabaseMetadata: vi.fn(),
  executeQuery: vi.fn(),
  buildUpdateDatabasePropertiesSql: vi.fn(),
  loadDatabases: vi.fn(),
  editorSettings: {
    shortcuts: { newQuery: "Mod+T" },
    objectBrowserViewMode: "list" as "list" | "grid" | "compact",
    objectBrowserCompactWidth: 160,
  },
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: (...args: unknown[]) => mocks.listDatabases(...args),
  listDatabaseMetadata: (...args: unknown[]) => mocks.listDatabaseMetadata(...args),
  executeQuery: (...args: unknown[]) => mocks.executeQuery(...args),
  buildUpdateDatabasePropertiesSql: (...args: unknown[]) => mocks.buildUpdateDatabasePropertiesSql(...args),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    loadDatabases: (...args: unknown[]) => mocks.loadDatabases(...args),
    connectionIdentifierQuote: () => "`",
    setDefaultDatabase: vi.fn(),
    clearDefaultDatabase: vi.fn(),
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    openObjectBrowser: vi.fn(),
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

vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({
  default: {
    props: ["open", "title", "message", "sql", "loading", "confirmLabel"],
    emits: ["update:open", "confirm"],
    setup(props: { sql?: string }, { emit }: { emit: (event: string) => void }) {
      return () => h("div", { "data-test-danger-dialog": "" }, [h("span", { "data-test-danger-sql": "" }, props.sql ?? ""), h("button", { "data-test-danger-confirm": "", onClick: () => emit("confirm") })]);
    },
  },
}));

describe("DatabaseBrowser default charset and collation pickers", () => {
  let app: App | undefined;
  let host: HTMLElement | undefined;

  beforeEach(() => {
    mocks.listDatabases.mockResolvedValue([databaseRow]);
    mocks.listDatabaseMetadata.mockResolvedValue([databaseRow]);
    mocks.buildUpdateDatabasePropertiesSql.mockResolvedValue(alterSql);
    mocks.loadDatabases.mockResolvedValue(undefined);
    mocks.executeQuery.mockImplementation((_connectionId: string, _database: string, sql: string) => {
      if (sql === "SHOW CHARACTER SET") {
        return Promise.resolve({
          columns: ["Charset", "Default collation", "Description", "Maxlen"],
          rows: [
            ["utf8mb4", "utf8mb4_0900_ai_ci", "", 4],
            ["gbk", "gbk_chinese_ci", "", 2],
          ],
        });
      }
      if (sql === "SHOW COLLATION") {
        return Promise.resolve({
          columns: ["Collation", "Charset", "Id", "Default", "Compiled", "Sortlen"],
          rows: [
            ["utf8mb4_0900_ai_ci", "utf8mb4", 255, "Yes", "Yes", 8],
            ["gbk_chinese_ci", "gbk", 28, "Yes", "Yes", 2],
            ["gbk_bin", "gbk", 87, "", "Yes", 1],
          ],
        });
      }
      return Promise.resolve({ columns: [], rows: [] });
    });
  });

  afterEach(() => {
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("changes the database default charset through the dropdown and runs ALTER DATABASE", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection });
    app.mount(host);

    await vi.waitFor(() => expect(host!.textContent).toContain("db_mysql"));
    host.querySelector<HTMLButtonElement>("[data-database-charset-trigger]")!.click();

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith(connection.id, "", "SHOW CHARACTER SET", undefined, undefined, { maxRows: 1000 }));

    let option: HTMLElement | undefined;
    await vi.waitFor(() => {
      option = document.querySelector<HTMLElement>('[data-database-charset-option="gbk"]') ?? undefined;
      expect(option).toBeTruthy();
    });
    option!.click();

    await vi.waitFor(() => expect(mocks.buildUpdateDatabasePropertiesSql).toHaveBeenCalledWith(expect.objectContaining({ target: "database", name: "db_mysql", charset: "gbk", collation: "gbk_chinese_ci" })));
    await vi.waitFor(() => expect(document.querySelector("[data-test-danger-sql]")?.textContent).toBe(alterSql));

    document.querySelector<HTMLButtonElement>("[data-test-danger-confirm]")!.click();

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith(connection.id, "db_mysql", alterSql));
    await vi.waitFor(() => expect(mocks.loadDatabases).toHaveBeenCalledWith(connection.id, { force: true }));
  });
});
