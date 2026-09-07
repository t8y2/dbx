import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetachedTabHandoff } from "@/lib/app/detachedTabHandoff";

const mocks = vi.hoisted(() => ({
  loadSavedSqlFile: vi.fn(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  loadSavedSqlFile: mocks.loadSavedSqlFile,
}));

describe("queryStore adoptDetachedTab", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    mocks.loadSavedSqlFile.mockReset();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  function handoffFor(overrides: Partial<DetachedTabHandoff["tab"]> = {}): DetachedTabHandoff {
    return {
      schemaVersion: 1,
      tabId: "tab-1",
      sourceWindowLabel: "main",
      revision: 1,
      tab: {
        id: "tab-1",
        title: "query_1.sql",
        customTitle: true,
        connectionId: "conn-1",
        database: "main",
        // A clean saved-SQL-library tab serializes `sql` as "" (see openTabsPersistence's
        // shouldPersistTabSql) to avoid duplicating on-disk state across app restarts.
        sql: "",
        savedSqlId: "saved-1",
        mode: "query",
        ...overrides,
      },
      runtime: {},
      updatedAt: Date.now(),
    };
  }

  it("hydrates a clean saved-SQL-library tab's content from the backend instead of opening empty", async () => {
    mocks.loadSavedSqlFile.mockResolvedValue({
      id: "saved-1",
      connectionId: "conn-1",
      name: "query_1.sql",
      database: "main",
      sql: "SELECT 1;",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const tabId = await queryStore.adoptDetachedTab(handoffFor());

    expect(mocks.loadSavedSqlFile).toHaveBeenCalledWith("saved-1");
    const tab = queryStore.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.sql).toBe("SELECT 1;");
    expect(tab.originalSql).toBe("SELECT 1;");
    expect(queryStore.isTabDirty(tab)).toBe(false);
  });

  it("does not touch the backend when the handoff already carries unsaved edits", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const tabId = await queryStore.adoptDetachedTab(handoffFor({ sql: "SELECT 2;", originalSql: "SELECT 1;" }));

    expect(mocks.loadSavedSqlFile).not.toHaveBeenCalled();
    const tab = queryStore.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.sql).toBe("SELECT 2;");
    expect(queryStore.isTabDirty(tab)).toBe(true);
  });

  it("leaves an unsaved (never-linked-to-library) tab's empty content as-is", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const tabId = await queryStore.adoptDetachedTab(handoffFor({ savedSqlId: undefined }));

    expect(mocks.loadSavedSqlFile).not.toHaveBeenCalled();
    const tab = queryStore.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.sql).toBe("");
  });
});
