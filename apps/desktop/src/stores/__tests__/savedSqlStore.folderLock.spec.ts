import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ savedFolders: [] as any[] }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  loadSavedSqlLibrary: async () => ({ folders: mocks.savedFolders, files: [] }),
  saveSavedSqlFolder: async (folder: unknown) => folder,
  deleteSavedSqlFolder: async () => {},
}));

describe("savedSqlStore folder lock state machine", () => {
  beforeEach(() => {
    mocks.savedFolders = [];
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    });
    setActivePinia(createPinia());
  });

  it("starts locked, unlocks for the session, and locks again on demand", async () => {
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const store = useSavedSqlStore();
    await store.initFromStorage();
    const folder = await store.createFolder("conn", "Secret");

    expect(store.isSavedSqlFolderUnlocked(folder.id)).toBe(false);
    store.unlockSavedSqlFolder(folder.id);
    expect(store.isSavedSqlFolderUnlocked(folder.id)).toBe(true);
    store.lockSavedSqlFolder(folder.id);
    expect(store.isSavedSqlFolderUnlocked(folder.id)).toBe(false);
  });

  it("stores a protection hash on creation when one is provided", async () => {
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const store = useSavedSqlStore();
    await store.initFromStorage();
    const folder = await store.createFolder("conn", "Secret", undefined, "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==");

    expect(store.allFolders.find((f) => f.id === folder.id)?.passwordHash).toBe("pbkdf2-sha256$600000$c2FsdA==$aGFzaA==");
  });

  it("invalidates the session unlock whenever the password is set or cleared", async () => {
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const store = useSavedSqlStore();
    await store.initFromStorage();
    const folder = await store.createFolder("conn", "Secret");

    store.unlockSavedSqlFolder(folder.id);
    await store.setSavedSqlFolderPassword(folder.id, "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==");
    expect(store.isSavedSqlFolderUnlocked(folder.id)).toBe(false);

    store.unlockSavedSqlFolder(folder.id);
    await store.setSavedSqlFolderPassword(folder.id, null);
    expect(store.isSavedSqlFolderUnlocked(folder.id)).toBe(false);
    expect(store.allFolders.find((f) => f.id === folder.id)?.passwordHash).toBeUndefined();
  });

  it("is a no-op for unknown folder ids", async () => {
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const store = useSavedSqlStore();
    await store.initFromStorage();

    await expect(store.setSavedSqlFolderPassword("missing", "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==")).resolves.toBeUndefined();
    expect(store.isSavedSqlFolderUnlocked("missing")).toBe(false);
  });
});
