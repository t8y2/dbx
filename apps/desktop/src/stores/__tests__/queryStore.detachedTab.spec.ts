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

  it.each(["SELECT 2;", ""])("does not replace unsaved edits %j with file content", async (sql) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const tabId = await queryStore.adoptDetachedTab(handoffFor({ sql, originalSql: "SELECT 1;" }));

    expect(mocks.loadSavedSqlFile).not.toHaveBeenCalled();
    const tab = queryStore.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.sql).toBe(sql);
    expect(queryStore.isTabDirty(tab)).toBe(true);
  });

  it.each(["clean", "dirty", "empty", "changed on disk"])("checks the %s document before restoring folds on both legs of a detached handoff", async (scenario) => {
    const sql = scenario === "empty" ? "" : "SELECT\n  1;";
    const file = { id: "saved-1", name: "query_1.sql", connectionId: "conn-1", database: "main", sql, createdAt: "", updatedAt: "" };
    const { useQueryStore } = await import("@/stores/queryStore");
    const source = useQueryStore();
    const id = source.openSavedSql(file);
    const draft = scenario === "dirty" ? "SELECT\n  2;" : sql;
    source.updateSql(id, draft);
    const ranges = draft ? [{ from: 6, to: 10 }] : [];
    source.updateEditorFolds(id, ranges, draft);
    const currentDisk = scenario === "changed on disk" ? "SELECT\n  3;" : sql;
    mocks.loadSavedSqlFile.mockResolvedValue({ ...file, sql: currentDisk });
    const handoff = await source.prepareDetachedTab(id);

    setActivePinia(createPinia());
    const detached = useQueryStore();
    await detached.adoptDetachedTab(handoff);
    const detachedTab = detached.tabs.find((tab) => tab.id === id)!;
    const expected = scenario === "changed on disk" ? [] : ranges;
    expect(detachedTab.sql).toBe(scenario === "dirty" ? draft : currentDisk);
    expect(detachedTab.editorFolds?.ranges ?? []).toEqual(expected);

    await source.adoptDetachedTab(await detached.prepareDetachedTab(id));
    expect(source.tabs.find((tab) => tab.id === id)?.editorFolds?.ranges ?? []).toEqual(expected);
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
