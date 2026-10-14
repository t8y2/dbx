import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ savedFolders: [] as any[] }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  loadSavedSqlLibrary: async () => ({ folders: mocks.savedFolders, files: [] }),
  saveSavedSqlFolder: async (folder: unknown) => folder,
  deleteSavedSqlFolder: async () => {},
}));

const PROTECTION_HASH = "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==";

async function setupStore() {
  const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
  const store = useSavedSqlStore();
  await store.initFromStorage();
  return store;
}

describe("savedSqlFolderAccess", () => {
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

  it("hides files of a locked folder and keeps reachable ones", async () => {
    const store = await setupStore();
    const open = await store.createFolder("conn", "Open");
    const locked = await store.createFolder("conn", "Secret", undefined, PROTECTION_HASH);
    const { excludeLockedSavedSqlFiles } = await import("@/lib/sidebar/savedSqlFolderAccess");

    const files = [{ folderId: locked.id }, { folderId: open.id }, {}];
    expect(excludeLockedSavedSqlFiles(files)).toEqual([{ folderId: open.id }, {}]);
  });

  it("hides files nested inside a locked branch", async () => {
    const store = await setupStore();
    const locked = await store.createFolder("conn", "Secret", undefined, PROTECTION_HASH);
    const child = await store.createFolder("conn", "Child", locked.id);
    const { excludeLockedSavedSqlFiles } = await import("@/lib/sidebar/savedSqlFolderAccess");

    expect(excludeLockedSavedSqlFiles([{ folderId: child.id }])).toEqual([]);
  });

  it("reveals a locked branch again once it is unlocked for the session", async () => {
    const store = await setupStore();
    const locked = await store.createFolder("conn", "Secret", undefined, PROTECTION_HASH);
    const { excludeLockedSavedSqlFiles } = await import("@/lib/sidebar/savedSqlFolderAccess");

    expect(excludeLockedSavedSqlFiles([{ folderId: locked.id }])).toEqual([]);
    store.unlockSavedSqlFolder(locked.id);
    expect(excludeLockedSavedSqlFiles([{ folderId: locked.id }])).toEqual([{ folderId: locked.id }]);
  });

  it("resolves the gating folder only for locked branches", async () => {
    const store = await setupStore();
    const open = await store.createFolder("conn", "Open");
    const locked = await store.createFolder("conn", "Secret", undefined, PROTECTION_HASH);
    const child = await store.createFolder("conn", "Child", locked.id);
    const { lockedFolderForSavedSqlFile } = await import("@/lib/sidebar/savedSqlFolderAccess");

    expect(lockedFolderForSavedSqlFile({})).toBeNull();
    expect(lockedFolderForSavedSqlFile({ folderId: open.id })).toBeNull();
    expect(lockedFolderForSavedSqlFile({ folderId: "missing" })).toBeNull();
    expect(lockedFolderForSavedSqlFile({ folderId: child.id })?.id).toBe(locked.id);
  });

  it("lets unfiled and unprotected files through without prompting", async () => {
    const store = await setupStore();
    const open = await store.createFolder("conn", "Open");
    const { ensureSavedSqlFileAccessible } = await import("@/lib/sidebar/savedSqlFolderAccess");
    const { useSavedSqlFolderPasswordPromptStore } = await import("@/stores/savedSqlFolderPasswordPromptStore");

    await expect(ensureSavedSqlFileAccessible({})).resolves.toBe(true);
    await expect(ensureSavedSqlFileAccessible({ folderId: open.id })).resolves.toBe(true);
    expect(useSavedSqlFolderPasswordPromptStore().current).toBeNull();
  });

  it("gates opening a locked file behind the prompt and unlocks on success", async () => {
    const store = await setupStore();
    const locked = await store.createFolder("conn", "Secret", undefined, PROTECTION_HASH);
    const { ensureSavedSqlFileAccessible } = await import("@/lib/sidebar/savedSqlFolderAccess");
    const { useSavedSqlFolderPasswordPromptStore } = await import("@/stores/savedSqlFolderPasswordPromptStore");

    const pending = ensureSavedSqlFileAccessible({ folderId: locked.id });
    const promptStore = useSavedSqlFolderPasswordPromptStore();
    expect(promptStore.current?.folderId).toBe(locked.id);
    promptStore.resolve(true);

    await expect(pending).resolves.toBe(true);
    expect(store.isSavedSqlFolderUnlocked(locked.id)).toBe(true);
  });

  it("keeps the folder locked when the password prompt is dismissed", async () => {
    const store = await setupStore();
    const locked = await store.createFolder("conn", "Secret", undefined, PROTECTION_HASH);
    const { ensureSavedSqlFileAccessible } = await import("@/lib/sidebar/savedSqlFolderAccess");
    const { useSavedSqlFolderPasswordPromptStore } = await import("@/stores/savedSqlFolderPasswordPromptStore");

    const pending = ensureSavedSqlFileAccessible({ folderId: locked.id });
    useSavedSqlFolderPasswordPromptStore().resolve(false);

    await expect(pending).resolves.toBe(false);
    expect(store.isSavedSqlFolderUnlocked(locked.id)).toBe(false);
  });
});
