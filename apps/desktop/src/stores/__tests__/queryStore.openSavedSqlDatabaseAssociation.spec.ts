import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig, SavedSqlFile } from "@/types/database";

const timestamp = "2026-09-01T00:00:00.000Z";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
}

describe("queryStore openSavedSql automatic database association", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("associates candidate database from filename when file database is empty", () => {
    const store = useQueryStore();
    const connStore = useConnectionStore();
    connStore.connections = [{ id: "conn-prod", name: "PROD", db_type: "mysql", database: "default_db" } as ConnectionConfig];

    const file: SavedSqlFile = {
      id: "saved-aisp",
      connectionId: "conn-prod",
      database: "",
      name: "aisp_aikf - 全量呼入数据.sql",
      sql: "SELECT 1;",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const tabId = store.openSavedSql(file);
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab).toBeDefined();
    expect(tab?.connectionId).toBe("conn-prod");
    expect(tab?.database).toBe("aisp_aikf");
  });

  it("inherits current tab database when file database is empty and no prefix exists", () => {
    const store = useQueryStore();
    const connStore = useConnectionStore();
    connStore.connections = [{ id: "conn-prod", name: "PROD", db_type: "mysql", database: "" } as ConnectionConfig];

    // Create an active tab with connection and database
    const activeTabId = store.createTab("conn-prod", "crm_active", "Active Tab", "query");
    store.activeTabId = activeTabId;

    const file: SavedSqlFile = {
      id: "saved-plain",
      connectionId: "conn-prod",
      database: "",
      name: "plain_query.sql",
      sql: "SELECT 2;",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const tabId = store.openSavedSql(file);
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab).toBeDefined();
    expect(tab?.connectionId).toBe("conn-prod");
    expect(tab?.database).toBe("crm_active");
  });

  it("falls back to connection default database when file database is empty and no active tab", () => {
    const store = useQueryStore();
    const connStore = useConnectionStore();
    connStore.connections = [{ id: "conn-prod", name: "PROD", db_type: "mysql", database: "configured_default_db" } as ConnectionConfig];

    const file: SavedSqlFile = {
      id: "saved-plain-fallback",
      connectionId: "conn-prod",
      database: "",
      name: "plain_query.sql",
      sql: "SELECT 3;",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const tabId = store.openSavedSql(file);
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab).toBeDefined();
    expect(tab?.connectionId).toBe("conn-prod");
    expect(tab?.database).toBe("configured_default_db");
  });

  it("preserves explicitly saved database on the file", () => {
    const store = useQueryStore();
    const connStore = useConnectionStore();
    connStore.connections = [{ id: "conn-prod", name: "PROD", db_type: "mysql", database: "default_db" } as ConnectionConfig];

    const file: SavedSqlFile = {
      id: "saved-explicit",
      connectionId: "conn-prod",
      database: "explicit_db",
      name: "aisp_aikf - query.sql",
      sql: "SELECT 4;",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const tabId = store.openSavedSql(file);
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.database).toBe("explicit_db");
  });
});
