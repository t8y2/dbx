import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSqlFile } from "@/types/database";

vi.mock("@/lib/backend/api", async (original) => ({
  ...(await original<typeof import("@/lib/backend/api")>()),
  loadSavedSqlFile: vi.fn(),
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
}));

const file: SavedSqlFile = { id: "bookmarked-file", name: "test.sql", connectionId: "", database: "", sql: "a\nb\nc", createdAt: "2026-01-01", updatedAt: "2026-01-01" };

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  setActivePinia(createPinia());
  await import("@/stores/queryStore");
}, 30_000);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function unhydratedTab() {
  const { useQueryStore } = await import("@/stores/queryStore");
  const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
  const store = useQueryStore();
  const id = store.openSavedSql({ ...file, sql: "" });
  const tab = store.tabs.find((tab) => tab.id === id)!;
  tab.originalSql = undefined;
  store.updateEditorBookmarks(id, [3, 99]);
  const saved = useSavedSqlStore();
  vi.spyOn(saved, "getFile").mockReturnValue(file);
  return { store, id, tab, saved };
}

describe("query SQL replacement bookmark synchronization", () => {
  it("hydrates an already-open saved file without shifting its persisted lines", async () => {
    const { store, tab } = await unhydratedTab();
    store.openSavedSql(file);
    expect(tab.sql).toBe(file.sql);
    expect(tab.editorBookmarks).toEqual([3]);
    expect(tab.editorBookmarksDocument).toBe(file.sql);
  });

  it("hydrates startup SQL and records the document associated with saved positions", async () => {
    const { store, tab, saved } = await unhydratedTab();
    vi.spyOn(saved, "ensureFileContent").mockResolvedValue(file);
    await store.hydrateSavedSqlTabs();
    expect(tab.sql).toBe(file.sql);
    expect(tab.editorBookmarks).toEqual([3]);
    expect(tab.editorBookmarksDocument).toBe(file.sql);
  });

  it("does not overwrite a draft edited while startup hydration was loading", async () => {
    const { store, id, tab, saved } = await unhydratedTab();
    let finish!: (value: SavedSqlFile) => void;
    const load = vi.spyOn(saved, "ensureFileContent").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const hydration = store.hydrateSavedSqlTabs();
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    store.updateSql(id, "new\na\nb\nc");
    store.updateEditorBookmarks(id, [4]);
    finish(file);
    await hydration;
    expect(tab.sql).toBe("new\na\nb\nc");
    expect(tab.editorBookmarks).toEqual([4]);
    expect(tab.editorBookmarksDocument).toBe(tab.sql);
  });

  it("hydrates detached saved-file handoffs as a document/bookmark pair", async () => {
    const { store, tab } = await unhydratedTab();
    const api = await import("@/lib/backend/api");
    vi.mocked(api.loadSavedSqlFile).mockResolvedValue(file);
    await store.adoptDetachedTab({ schemaVersion: 1, tabId: tab.id, tab: { ...tab }, runtime: {}, sourceWindowLabel: "main", revision: 1, updatedAt: Date.now() });
    const adopted = store.tabs.find((item) => item.id === tab.id)!;
    expect(adopted.sql).toBe(file.sql);
    expect(adopted.editorBookmarks).toEqual([3]);
    expect(adopted.editorBookmarksDocument).toBe(file.sql);
  });

  it.each(["baseline", "saved-empty", "scratch-empty"])("maps bookmarks when discarding %s changes", async (kind) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("", "", "draft", "query", undefined, "new\na\nb\nc");
    const tab = store.tabs.find((tab) => tab.id === id)!;
    tab.originalSql = kind === "baseline" ? "a\nb\nc" : undefined;
    if (kind === "saved-empty") tab.savedSqlId = file.id;
    store.updateEditorBookmarks(id, [3]);
    expect(store.discardTabChanges(id)).toBe(true);
    expect(tab.sql).toBe(kind === "baseline" ? "a\nb\nc" : "");
    expect(tab.editorBookmarks).toEqual(kind === "baseline" ? [2] : [1]);
    expect(tab.editorBookmarksDocument).toBe(tab.sql);
  });

  it("clears a discarded detached scratch document without leaving out-of-range bookmarks", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("", "", "draft", "query", undefined, "a\nb\nc");
    const tab = store.tabs.find((tab) => tab.id === id)!;
    store.updateEditorBookmarks(id, [3]);
    expect(store.requestWindowCloseConfirmation()).toBe(true);
    store.forceClosePendingTab();
    expect(tab.sql).toBe("");
    expect(tab.editorBookmarks).toEqual([1]);
    expect(tab.editorBookmarksDocument).toBe("");
  });
});
