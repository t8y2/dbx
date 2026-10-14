import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useSavedSqlFolderPasswordPromptStore } from "@/stores/savedSqlFolderPasswordPromptStore";

describe("savedSqlFolderPasswordPromptStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("exposes the pending request and resolves it with the unlock result", async () => {
    const store = useSavedSqlFolderPasswordPromptStore();
    const promise = store.requestPassword({ folderId: "f1", folderName: "Secret", verify: async () => true });
    expect(store.current?.folderId).toBe("f1");

    store.resolve(true);
    await expect(promise).resolves.toBe(true);
    expect(store.current).toBeNull();
  });

  it("resolves false for a rejected verification and clears the prompt", async () => {
    const store = useSavedSqlFolderPasswordPromptStore();
    const promise = store.requestPassword({ folderId: "f1", folderName: "Secret", verify: async () => false });

    store.resolve(false);
    await expect(promise).resolves.toBe(false);
    expect(store.current).toBeNull();
  });

  it("rejects a concurrent request while a prompt is already open", async () => {
    const store = useSavedSqlFolderPasswordPromptStore();
    const first = store.requestPassword({ folderId: "f1", folderName: "A", verify: async () => true });
    const second = store.requestPassword({ folderId: "f2", folderName: "B", verify: async () => true });

    await expect(second).resolves.toBe(false);
    // The first prompt is still the active one and completes normally.
    expect(store.current?.folderId).toBe("f1");
    store.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(store.current).toBeNull();
  });

  it("keeps prompting after a completed request", async () => {
    const store = useSavedSqlFolderPasswordPromptStore();
    const first = store.requestPassword({ folderId: "f1", folderName: "A", verify: async () => true });
    store.resolve(false);
    await expect(first).resolves.toBe(false);

    const second = store.requestPassword({ folderId: "f2", folderName: "B", verify: async () => true });
    expect(store.current?.folderId).toBe("f2");
    store.resolve(true);
    await expect(second).resolves.toBe(true);
  });
});
