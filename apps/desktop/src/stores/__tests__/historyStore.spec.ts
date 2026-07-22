import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import type { HistoryEntry, HistorySearchRequest, HistorySearchResult } from "@/lib/backend/api";
import { useHistoryStore } from "@/stores/historyStore";

vi.mock("@/lib/backend/api", () => ({
  searchHistory: vi.fn(),
  saveHistory: vi.fn(),
  deleteHistoryEntry: vi.fn(),
  clearHistory: vi.fn(),
  loadHistoryConnectionOptions: vi.fn(),
}));

const request: HistorySearchRequest = {
  search_text: "",
  connections: [],
  databases: [],
  limit: 100,
};

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "history-1",
    connection_id: "conn-a",
    connection_name: "Primary",
    database: "sales",
    sql: "select 1",
    executed_at: "2026-07-18T08:00:00.000Z",
    execution_time_ms: 10,
    success: true,
    activity_kind: "query",
    ...overrides,
  };
}

function addInput(stored = entry()): Omit<HistoryEntry, "id" | "executed_at"> {
  const { id: _id, executed_at: _executedAt, ...input } = stored;
  return input;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("historyStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.loadHistoryConnectionOptions).mockResolvedValue([]);
  });

  it("ignores a delayed search after deleting an entry", async () => {
    const stored = entry();
    vi.mocked(api.searchHistory).mockResolvedValueOnce({ entries: [stored], total: 1, next_cursor: null });
    const store = useHistoryStore();
    await store.search(request);

    const delayed = deferred<HistorySearchResult>();
    vi.mocked(api.searchHistory).mockReturnValueOnce(delayed.promise);
    vi.mocked(api.deleteHistoryEntry).mockResolvedValue(undefined);
    const searchPromise = store.search(request);
    await store.remove(stored.id);
    delayed.resolve({ entries: [stored], total: 1, next_cursor: { executed_at: stored.executed_at, id: stored.id } });
    await searchPromise;

    expect(store.entries).toEqual([]);
    expect(store.total).toBe(0);
    expect(store.nextCursor).toBeNull();
  });

  it("ignores a delayed search after clearing history", async () => {
    const stored = entry();
    vi.mocked(api.searchHistory).mockResolvedValueOnce({ entries: [stored], total: 1, next_cursor: null });
    const store = useHistoryStore();
    await store.search(request);

    const delayed = deferred<HistorySearchResult>();
    vi.mocked(api.searchHistory).mockReturnValueOnce(delayed.promise);
    vi.mocked(api.clearHistory).mockResolvedValue(undefined);
    const searchPromise = store.search(request);
    await store.clear();
    delayed.resolve({ entries: [stored], total: 1, next_cursor: { executed_at: stored.executed_at, id: stored.id } });
    await searchPromise;

    expect(store.entries).toEqual([]);
    expect(store.total).toBe(0);
    expect(store.nextCursor).toBeNull();
  });

  it("ignores a search started while deletion is pending", async () => {
    const stored = entry();
    vi.mocked(api.searchHistory).mockResolvedValueOnce({ entries: [stored], total: 1, next_cursor: null });
    const store = useHistoryStore();
    await store.search(request);

    const deletion = deferred<void>();
    const delayedSearch = deferred<HistorySearchResult>();
    vi.mocked(api.deleteHistoryEntry).mockReturnValueOnce(deletion.promise);
    vi.mocked(api.searchHistory).mockReturnValueOnce(delayedSearch.promise);
    const removePromise = store.remove(stored.id);
    const searchPromise = store.search(request);
    deletion.resolve(undefined);
    await removePromise;
    delayedSearch.resolve({ entries: [stored], total: 1, next_cursor: { executed_at: stored.executed_at, id: stored.id } });
    await searchPromise;

    expect(store.entries).toEqual([]);
    expect(store.total).toBe(0);
    expect(store.nextCursor).toBeNull();
    expect(store.loading).toBe(false);
  });

  it("does not restore connection options returned after clear", async () => {
    const delayedOptions = deferred<Awaited<ReturnType<typeof api.loadHistoryConnectionOptions>>>();
    vi.mocked(api.loadHistoryConnectionOptions).mockReturnValueOnce(delayedOptions.promise);
    vi.mocked(api.clearHistory).mockResolvedValue(undefined);
    const store = useHistoryStore();
    const optionsPromise = store.loadConnectionOptions();
    await store.clear();
    delayedOptions.resolve([{ connection_id: "conn-a", connection_name: "Primary", databases: ["sales"] }]);
    await optionsPromise;

    expect(store.connectionOptions).toEqual([]);
  });

  it("does not let delayed connection options overwrite a newly added option", async () => {
    const delayedOptions = deferred<Awaited<ReturnType<typeof api.loadHistoryConnectionOptions>>>();
    vi.mocked(api.loadHistoryConnectionOptions).mockReturnValueOnce(delayedOptions.promise);
    vi.mocked(api.saveHistory).mockResolvedValue(undefined);
    const store = useHistoryStore();
    const optionsPromise = store.loadConnectionOptions();
    await store.add(addInput());
    delayedOptions.resolve([]);
    await optionsPromise;

    expect(store.connectionOptions).toEqual([{ connection_id: "conn-a", connection_name: "Primary", databases: ["sales"] }]);
  });

  it("refreshes an active panel even when its initial search is still pending", async () => {
    const initialSearch = deferred<HistorySearchResult>();
    const persisted = entry({ id: "persisted-new" });
    vi.mocked(api.searchHistory)
      .mockReturnValueOnce(initialSearch.promise)
      .mockResolvedValueOnce({ entries: [persisted], total: 1, next_cursor: null });
    vi.mocked(api.saveHistory).mockResolvedValue(undefined);
    const store = useHistoryStore();
    store.setHistoryPanelActive(true);
    const initialPromise = store.search(request);

    await store.add(addInput());
    initialSearch.resolve({ entries: [], total: 0, next_cursor: null });
    await initialPromise;

    expect(store.entries).toEqual([persisted]);
    expect(store.total).toBe(1);
  });

  it("does not refresh after the history panel closes", async () => {
    vi.mocked(api.saveHistory).mockResolvedValue(undefined);
    const store = useHistoryStore();
    store.setHistoryPanelActive(true);
    store.setHistoryPanelActive(false);

    await store.add(addInput());

    expect(api.searchHistory).not.toHaveBeenCalled();
  });

  it("refreshes from storage after insertion instead of exceeding the persisted limit", async () => {
    const stored = entry();
    vi.mocked(api.searchHistory)
      .mockResolvedValueOnce({ entries: [stored], total: 1000, next_cursor: null })
      .mockResolvedValueOnce({ entries: [entry({ id: "persisted-new" })], total: 1000, next_cursor: null });
    vi.mocked(api.saveHistory).mockResolvedValue(undefined);
    const store = useHistoryStore();
    store.setHistoryPanelActive(true);
    await store.search(request);

    await store.add(addInput(stored));

    expect(store.total).toBe(1000);
    expect(store.entries[0]?.id).toBe("persisted-new");
  });

  it("uses SQLite results for non-ASCII text searches", async () => {
    const filteredRequest = { ...request, search_text: "Ä" };
    vi.mocked(api.searchHistory).mockResolvedValue({ entries: [], total: 0, next_cursor: null });
    vi.mocked(api.saveHistory).mockResolvedValue(undefined);
    const store = useHistoryStore();
    store.setHistoryPanelActive(true);
    await store.search(filteredRequest);

    const stored = entry({ sql: "select 'ä'" });
    await store.add(addInput(stored));

    expect(store.entries).toEqual([]);
    expect(store.total).toBe(0);
    expect(vi.mocked(api.searchHistory).mock.calls.at(-1)?.[0].search_text).toBe("Ä");
  });
});
