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

const productionConnection: ConnectionConfig = { ...connection, is_production: true };

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
  requestProductionConfirmation: vi.fn(),
  toast: vi.fn(),
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

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: (...args: unknown[]) => mocks.toast(...args) }),
}));

// Only the confirmation prompt is stubbed: the real guard (risk assessment plus
// the read-only check) must still decide whether the DDL is dispatched.
vi.mock("@/stores/productionSafetyStore", () => ({
  useProductionSafetyStore: () => ({ requestConfirmation: (...args: unknown[]) => mocks.requestProductionConfirmation(...args) }),
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

  /** Mounts the browser, picks gbk in the charset dropdown and leaves the danger
   *  dialog open with the ALTER previewed — the shared starting point for every
   *  assertion about what confirming (or cancelling) actually dispatches. */
  async function openCharsetChangeConfirm(target: ConnectionConfig) {
    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection: target });
    app.mount(host);

    await vi.waitFor(() => expect(host!.textContent).toContain("db_mysql"));
    host.querySelector<HTMLButtonElement>("[data-database-charset-trigger]")!.click();

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith(target.id, "", "SHOW CHARACTER SET", undefined, undefined, { maxRows: 1000 }));

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-database-charset-option="gbk"]')).toBeTruthy();
    });
    document.querySelector<HTMLElement>('[data-database-charset-option="gbk"]')!.click();

    await vi.waitFor(() => expect(mocks.buildUpdateDatabasePropertiesSql).toHaveBeenCalledWith(expect.objectContaining({ target: "database", name: "db_mysql", charset: "gbk", collation: "gbk_chinese_ci" })));
    await vi.waitFor(() => expect(document.querySelector("[data-test-danger-sql]")?.textContent).toBe(alterSql));
  }

  function confirmDangerDialog() {
    document.querySelector<HTMLButtonElement>("[data-test-danger-confirm]")!.click();
  }

  it("changes the database default charset through the dropdown and runs ALTER DATABASE", async () => {
    await openCharsetChangeConfirm(connection);

    confirmDangerDialog();

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith(connection.id, "db_mysql", alterSql));
    await vi.waitFor(() => expect(mocks.loadDatabases).toHaveBeenCalledWith(connection.id, { force: true }));
  });

  it("runs the ALTER on a production database only after the production confirmation", async () => {
    mocks.requestProductionConfirmation.mockResolvedValue(true);
    await openCharsetChangeConfirm(productionConnection);

    confirmDangerDialog();

    await vi.waitFor(() => expect(mocks.requestProductionConfirmation).toHaveBeenCalledWith(expect.objectContaining({ database: "db_mysql", sql: alterSql })));
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith(productionConnection.id, "db_mysql", alterSql));
  });

  it("sends no DDL and reports no success when the production confirmation is cancelled", async () => {
    mocks.requestProductionConfirmation.mockResolvedValue(false);
    await openCharsetChangeConfirm(productionConnection);

    confirmDangerDialog();

    await vi.waitFor(() => expect(mocks.requestProductionConfirmation).toHaveBeenCalled());
    // Nothing reached the server: no ALTER, no refresh, and above all no
    // "charset changed" toast claiming a change that never happened.
    expect(mocks.executeQuery).not.toHaveBeenCalledWith(productionConnection.id, "db_mysql", alterSql);
    expect(mocks.loadDatabases).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalledWith("databaseBrowser.charsetChangeSuccess", expect.anything());
    // The dialog stays open so the user can review and confirm again.
    expect(document.querySelector("[data-test-danger-sql]")?.textContent).toBe(alterSql);
  });
});
