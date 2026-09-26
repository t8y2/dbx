import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useFavoritesStore } from "../favoritesStore";
import type { TableFavorite } from "@/types/favorites";

const api = vi.hoisted(() => ({ listTableFavorites: vi.fn(), createTableFavorite: vi.fn(), updateTableFavorite: vi.fn(), removeTableFavorite: vi.fn(), relinkTableFavorite: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const a: TableFavorite = { id: "a", code: "F0001", name: "users", connectionId: "c", catalog: "", database: "db", schema: "public", objectType: "table", objectName: "users", revision: 1, createdAt: 1, updatedAt: 1 };

describe("favoritesStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
    api.listTableFavorites.mockResolvedValue({ items: [] });
  });

  it("coalesces list requests and retains records when refresh fails", async () => {
    const store = useFavoritesStore();
    const pending = deferred<{ items: TableFavorite[] }>();
    api.listTableFavorites.mockReturnValueOnce(pending.promise);
    const first = store.refresh();
    const second = store.refresh();
    expect(api.listTableFavorites).toHaveBeenCalledTimes(1);
    pending.resolve({ items: [a] });
    await Promise.all([first, second]);
    api.listTableFavorites.mockRejectedValueOnce(new Error("offline"));
    await store.refresh();
    expect(store.items).toEqual([a]);
    expect(store.error).toBe("offline");
    expect(store.loading).toBe(false);
  });

  it("does not let an old list overwrite a committed create", async () => {
    const store = useFavoritesStore();
    const old = deferred<{ items: TableFavorite[] }>();
    const fresh = deferred<{ items: TableFavorite[] }>();
    api.listTableFavorites.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const loading = store.refresh();
    api.createTableFavorite.mockResolvedValueOnce({ item: a, created: true });
    await store.create({ target: a, name: a.name });
    old.resolve({ items: [] });
    await loading;
    expect(store.items).toEqual([a]);
    expect(store.loading).toBe(true);
    fresh.resolve({ items: [a] });
    await store.refresh();
    expect(store.items).toEqual([a]);
  });

  it("resets cached data and rejects stale responses after logout", async () => {
    const store = useFavoritesStore();
    const old = deferred<{ items: TableFavorite[] }>();
    api.listTableFavorites.mockReturnValueOnce(old.promise);
    const loading = store.refresh();
    store.reset();
    old.resolve({ items: [a] });
    await loading;
    expect(store.items).toEqual([]);
    expect(store.initialized).toBe(false);
  });

  it("does not resurrect a record from a write completed after reset", async () => {
    const store = useFavoritesStore();
    const pending = deferred<{ item: TableFavorite; created: boolean }>();
    api.createTableFavorite.mockReturnValueOnce(pending.promise);
    const writing = store.create({ target: a, name: a.name });
    store.reset();
    pending.resolve({ item: a, created: true });
    await expect(writing).rejects.toThrow("FAVORITE_CONTEXT_CHANGED");
    expect(store.items).toEqual([]);
    expect(store.pending).toBe(0);
    expect(api.listTableFavorites).not.toHaveBeenCalled();
  });

  it("opens existing targets for editing with a revision snapshot", async () => {
    api.listTableFavorites.mockResolvedValueOnce({ items: [a] });
    const store = useFavoritesStore();
    await store.addTarget(a);
    expect(store.dialog).toEqual({ mode: "edit", item: a });
    expect(api.createTableFavorite).not.toHaveBeenCalled();
  });

  it("does not invent a saved favorite when creation fails; reconciles a possible commit", async () => {
    const store = useFavoritesStore();
    api.createTableFavorite.mockRejectedValueOnce(new Error("timeout"));
    api.listTableFavorites.mockResolvedValue({ items: [a] });
    await expect(store.create({ target: a, name: a.name })).rejects.toThrow("timeout");
    await store.refresh();
    expect(store.items).toEqual([a]);
    expect(api.createTableFavorite).toHaveBeenCalledTimes(1);
  });

  it("sends revision on delete and never saves the whole array", async () => {
    const store = useFavoritesStore();
    const b = { ...a, id: "b", objectName: "other", code: "F0002" };
    store.items = [a, b];
    api.removeTableFavorite.mockResolvedValueOnce(undefined);
    api.listTableFavorites.mockResolvedValue({ items: [b] });
    await store.remove(a);
    await store.refresh();
    expect(api.removeTableFavorite).toHaveBeenCalledWith("a", 1);
    expect(store.items).toEqual([b]);
  });

  it("surfaces revision conflict without retrying the write", async () => {
    const store = useFavoritesStore();
    store.items = [a];
    api.updateTableFavorite.mockRejectedValueOnce(new Error("FAVORITE_REVISION_CONFLICT: changed"));
    api.listTableFavorites.mockResolvedValue({ items: [{ ...a, revision: 2, name: "remote" }] });
    await expect(store.update(a.id, { name: "local", code: a.code, expectedRevision: 1 })).rejects.toThrow("FAVORITE_REVISION_CONFLICT");
    await store.refresh();
    expect(store.items[0].name).toBe("remote");
    expect(api.updateTableFavorite).toHaveBeenCalledTimes(1);
  });

  it("relinks through its dedicated endpoint and updates the target index", async () => {
    const store = useFavoritesStore();
    store.items = [a];
    const moved = { ...a, objectName: "renamed", revision: 2 };
    api.relinkTableFavorite.mockResolvedValueOnce(moved);
    api.listTableFavorites.mockResolvedValue({ items: [moved] });
    await store.relink(a.id, { target: moved, expectedRevision: 1 });
    await store.refresh();
    expect(store.byTarget.size).toBe(1);
    expect(store.items[0]).toEqual(moved);
  });
});
