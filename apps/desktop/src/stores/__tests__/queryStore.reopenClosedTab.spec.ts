import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSqlFile } from "@/types/database";
import { workspaceBookmarkCases } from "@/lib/editor/__tests__/workspaceBookmarkCases";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
}));

describe("queryStore reopenClosedTab", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      setTimeout: vi.fn((_fn: () => void) => 0),
      clearTimeout: vi.fn(),
    });
    setActivePinia(createPinia());
    // Keep cold store-module loading in setup, outside each behavior test's timeout.
    await import("@/stores/queryStore");
  }, 30_000);

  afterEach(() => vi.restoreAllMocks());

  async function closeDefaultQuery(sql: string, bookmarks: number[]) {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const store = useQueryStore();
    const file: SavedSqlFile = {
      id: "default-query",
      name: "default.sql",
      connectionId: "pg-1",
      database: "app",
      sql,
      isDefaultQuery: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const id = store.openSavedSql(file);
    store.updateEditorBookmarks(id, bookmarks);
    store.closeTab(id, { force: true });
    expect(store.tabs.find((tab) => tab.id === id)).toBeUndefined();
    return { store, file, savedSqlStore: useSavedSqlStore() };
  }

  it.each([
    ...workspaceBookmarkCases,
    { name: "unchanged SQL", before: "one\ntwo\nthree", after: "one\ntwo\nthree", saved: [2], expected: [2] },
    { name: "a prepended line", before: "one\ntwo\nthree", after: "new\none\ntwo\nthree", saved: [2], expected: [3] },
    { name: "a removed line", before: "one\ntwo\nthree", after: "two\nthree", saved: [3], expected: [2] },
    { name: "CRLF content", before: "one\r\ntwo\r\nthree", after: "new\r\none\r\ntwo\r\nthree", saved: [2], expected: [3] },
    { name: "previously unhydrated SQL", before: "", after: "one\ntwo\nthree", saved: [3], expected: [3] },
    { name: "no saved bookmarks", before: "one\ntwo", after: "new\none\ntwo", saved: [], expected: [] },
  ])("restores default-query bookmarks against the latest document with $name", async ({ before, after, saved, expected }) => {
    const { store, file, savedSqlStore } = await closeDefaultQuery(before, saved);
    const snapshot = store.closedTabsHistory[0]!.tab;
    vi.spyOn(savedSqlStore, "ensureDefaultQuery").mockResolvedValue({ ...file, sql: after });
    expect(store.reopenClosedTab()).toBeNull();
    await vi.waitFor(() => expect(store.tabs.some((tab) => tab.savedSqlId === file.id)).toBe(true));
    const reopened = store.tabs.find((tab) => tab.savedSqlId === file.id)!;
    expect(reopened.sql).toBe(after);
    expect(reopened.originalSql).toBe(after);
    expect(reopened.editorBookmarks).toEqual(expected);
    expect(reopened.editorBookmarks).not.toBe(snapshot.editorBookmarks);
    expect(store.activeTabId).toBe(reopened.id);
  });

  it("keeps an already reopened default query's current bookmarks", async () => {
    const { store, file, savedSqlStore } = await closeDefaultQuery("one\ntwo\nthree", [2]);
    const existingId = store.openSavedSql(file);
    store.updateEditorBookmarks(existingId, [3]);
    const load = vi.spyOn(savedSqlStore, "ensureDefaultQuery");
    expect(store.reopenClosedTab()).toBe(existingId);
    expect(store.tabs.find((tab) => tab.id === existingId)?.editorBookmarks).toEqual([3]);
    expect(load).not.toHaveBeenCalled();
  });

  it("does not attach the deleted default file's bookmarks to its replacement", async () => {
    const { store, file, savedSqlStore } = await closeDefaultQuery("one\ntwo\nthree", [2]);
    vi.spyOn(savedSqlStore, "ensureDefaultQuery").mockResolvedValue({ ...file, id: "replacement-default" });
    store.reopenClosedTab();
    await vi.waitFor(() => expect(store.tabs.some((tab) => tab.savedSqlId === "replacement-default")).toBe(true));
    expect(store.tabs.find((tab) => tab.savedSqlId === "replacement-default")?.editorBookmarks).toBeUndefined();
  });

  it("does not overwrite bookmarks on a default query opened while its restore is loading", async () => {
    const { store, file, savedSqlStore } = await closeDefaultQuery("one\ntwo\nthree", [2]);
    let resolveFile!: (file: SavedSqlFile) => void;
    vi.spyOn(savedSqlStore, "ensureDefaultQuery").mockReturnValue(
      new Promise((resolve) => {
        resolveFile = resolve;
      }),
    );
    store.reopenClosedTab();
    const existingId = store.openSavedSql(file);
    store.updateEditorBookmarks(existingId, [3]);
    resolveFile(file);
    // Drain the asynchronous ensureDefaultQuery/openDefaultQuery continuation.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.tabs.filter((tab) => tab.savedSqlId === file.id)).toHaveLength(1);
    expect(store.tabs.find((tab) => tab.id === existingId)?.editorBookmarks).toEqual([3]);
  });

  it("reopens a recently closed query tab with its SQL, database, and position preserved", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query 1", "query");
    const tab = store.tabs.find((t) => t.id === tabId)!;
    tab.sql = "SELECT * FROM users WHERE active = true";

    expect(store.canReopenClosedTab).toBe(false);

    store.closeTab(tabId, { force: true });
    expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined();
    expect(store.canReopenClosedTab).toBe(true);

    const reopenedId = store.reopenClosedTab();
    expect(reopenedId).toBeTruthy();
    expect(store.canReopenClosedTab).toBe(false);

    const reopenedTab = store.tabs.find((t) => t.id === reopenedId);
    expect(reopenedTab).toBeDefined();
    expect(reopenedTab?.title).toBe("Query 1");
    expect(reopenedTab?.connectionId).toBe("pg-1");
    expect(reopenedTab?.database).toBe("app");
    expect(reopenedTab?.sql).toBe("SELECT * FROM users WHERE active = true");
    expect(store.activeTabId).toBe(reopenedId);
  });

  it("reopens multiple closed tabs in LIFO order", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    store.createTab("pg-1", "app", "Query 1", "query");
    const id2 = store.createTab("pg-1", "app", "Query 2", "query");
    const id3 = store.createTab("pg-1", "app", "Query 3", "query");

    store.closeTab(id2);
    store.closeTab(id3);

    expect(store.closedTabsHistory.length).toBe(2);

    // LIFO: most recently closed (id3) is reopened first
    const reopenedIdFirst = store.reopenClosedTab();
    const tabFirst = store.tabs.find((t) => t.id === reopenedIdFirst);
    expect(tabFirst?.title).toBe("Query 3");

    // Next is id2
    const reopenedIdSecond = store.reopenClosedTab();
    const tabSecond = store.tabs.find((t) => t.id === reopenedIdSecond);
    expect(tabSecond?.title).toBe("Query 2");

    expect(store.canReopenClosedTab).toBe(false);
    expect(store.reopenClosedTab()).toBeNull();
  });

  it("returns null when closed tabs history is empty", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    expect(store.canReopenClosedTab).toBe(false);
    expect(store.reopenClosedTab()).toBeNull();
  });

  it("clears closed tabs history on clearClosedTabsHistory", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("pg-1", "app", "Query 1", "query");
    store.closeTab(id);
    expect(store.canReopenClosedTab).toBe(true);

    store.clearClosedTabsHistory();
    expect(store.canReopenClosedTab).toBe(false);
    expect(store.reopenClosedTab()).toBeNull();
  });

  it("reopens tab into focused group if original group was pruned", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    store.createTab("pg-1", "app", "Query 1", "query");
    const id2 = store.createTab("pg-1", "app", "Query 2", "query");

    expect(store.splitTabDown(id2)).toBe(true);
    expect(store.groups.length).toBe(2);

    // Closing id2 leaves the second group empty, so it gets pruned
    store.closeTab(id2);
    expect(store.groups.length).toBe(1);

    // Reopening id2 falls back to the remaining group
    const reopenedId = store.reopenClosedTab();
    expect(reopenedId).toBeTruthy();
    expect(store.groups[0].tabIds).toContain(reopenedId);
    expect(store.activeTabId).toBe(reopenedId);
  });

  it("respects pinned tab boundaries when reopening an unpinned tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const pinnedId = store.createTab("pg-1", "app", "Pinned Query", "query");
    const pinnedTab = store.tabs.find((t) => t.id === pinnedId)!;
    pinnedTab.pinned = true;

    const unpinnedId = store.createTab("pg-1", "app", "Regular Query", "query");
    store.closeTab(unpinnedId);

    const reopenedId = store.reopenClosedTab();
    expect(reopenedId).toBeTruthy();

    const group = store.groups[0];
    const pinnedIndex = group.tabIds.indexOf(pinnedId);
    const reopenedIndex = group.tabIds.indexOf(reopenedId!);
    expect(pinnedIndex).toBe(0);
    expect(reopenedIndex).toBeGreaterThan(pinnedIndex);
  });
});
