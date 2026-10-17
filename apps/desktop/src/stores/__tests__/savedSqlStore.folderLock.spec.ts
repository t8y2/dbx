import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ savedFolders: [] as any[] }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  loadSavedSqlLibrary: async () => ({ folders: mocks.savedFolders, files: [] }),
  saveSavedSqlFolder: async (folder: unknown) => folder,
  deleteSavedSqlFolder: async () => {},
  setSavedSqlFolderPassword: async () => {},
  clearSavedSqlFolderPassword: async () => {},
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

  it("marks a folder protected through the backend set command", async () => {
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const store = useSavedSqlStore();
    await store.initFromStorage();
    const folder = await store.createFolder("conn", "Secret");

    // The verifier is minted by the backend command; the store only flips the
    // hasPassword flag that drives the lock UI.
    expect(store.allFolders.find((f) => f.id === folder.id)?.hasPassword).toBe(false);
    await store.setSavedSqlFolderPassword(folder.id, "pw");
    expect(store.allFolders.find((f) => f.id === folder.id)?.hasPassword).toBe(true);
  });

  it("invalidates the session unlock whenever the password is set or cleared", async () => {
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const store = useSavedSqlStore();
    await store.initFromStorage();
    const folder = await store.createFolder("conn", "Secret");

    store.unlockSavedSqlFolder(folder.id);
    await store.setSavedSqlFolderPassword(folder.id, "pw");
    expect(store.isSavedSqlFolderUnlocked(folder.id)).toBe(false);

    store.unlockSavedSqlFolder(folder.id);
    // Clearing goes through the login-password-gated recovery command.
    await store.clearSavedSqlFolderPassword(folder.id, "login-pw");
    expect(store.isSavedSqlFolderUnlocked(folder.id)).toBe(false);
    expect(store.allFolders.find((f) => f.id === folder.id)?.hasPassword).toBe(false);
  });

  it("is a no-op for unknown folder ids", async () => {
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const store = useSavedSqlStore();
    await store.initFromStorage();

    await expect(store.setSavedSqlFolderPassword("missing", "pw")).resolves.toBeUndefined();
    await expect(store.clearSavedSqlFolderPassword("missing", "login-pw")).resolves.toBeUndefined();
    expect(store.isSavedSqlFolderUnlocked("missing")).toBe(false);
  });
});
