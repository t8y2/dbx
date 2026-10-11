import { describe, expect, it, vi } from "vitest";
import { useSaveSqlFolderSelection } from "@/composables/useSaveSqlFolderSelection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("save SQL folder selection", () => {
  it("keeps save and reselection blocked until folder creation completes", async () => {
    const creation = deferred<string>();
    const folder = useSaveSqlFolderSelection("existing-folder");

    const pendingSelection = folder.select("new-folder", () => creation.promise);
    await folder.select("other-folder");

    expect(folder.pending.value).toBe(true);
    expect(folder.selection.value).toBe("existing-folder");

    creation.resolve("created-folder");
    await pendingSelection;

    expect(folder.pending.value).toBe(false);
    expect(folder.selection.value).toBe("created-folder");
  });

  it("preserves the previous valid selection when folder creation fails", async () => {
    const onError = vi.fn();
    const folder = useSaveSqlFolderSelection("existing-folder");

    await folder.select("new-folder", () => Promise.reject(new Error("create failed")), onError);

    expect(folder.pending.value).toBe(false);
    expect(folder.selection.value).toBe("existing-folder");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("ignores stale folder creation after the dialog selection session resets", async () => {
    const creation = deferred<string>();
    const folder = useSaveSqlFolderSelection("first-folder");
    const pendingSelection = folder.select("new-folder", () => creation.promise);

    folder.reset("later-folder");
    creation.resolve("stale-created-folder");
    await pendingSelection;

    expect(folder.pending.value).toBe(false);
    expect(folder.selection.value).toBe("later-folder");
  });

  it("handles startCreating and cancelCreating lifecycle", () => {
    const folder = useSaveSqlFolderSelection("existing-folder");
    expect(folder.isCreating.value).toBe(false);

    folder.startCreating();
    expect(folder.isCreating.value).toBe(true);
    expect(folder.newFolderName.value).toBe("");

    folder.newFolderName.value = "my-new-folder";
    folder.cancelCreating();
    expect(folder.isCreating.value).toBe(false);
    expect(folder.newFolderName.value).toBe("");
  });

  it("successfully creates a folder via confirmCreating", async () => {
    const folder = useSaveSqlFolderSelection("existing-folder");
    folder.startCreating();
    folder.newFolderName.value = "  Analytics  ";

    const createFn = vi.fn().mockResolvedValue("analytics-id");
    const result = await folder.confirmCreating(createFn);

    expect(result).toBe(true);
    expect(createFn).toHaveBeenCalledWith("Analytics");
    expect(folder.isCreating.value).toBe(false);
    expect(folder.newFolderName.value).toBe("");
    expect(folder.selection.value).toBe("analytics-id");
    expect(folder.pending.value).toBe(false);
  });

  it("handles failure in confirmCreating without resetting typed name", async () => {
    const onError = vi.fn();
    const folder = useSaveSqlFolderSelection("existing-folder");
    folder.startCreating();
    folder.newFolderName.value = "Invalid/Folder";

    const createFn = vi.fn().mockRejectedValue(new Error("Invalid folder name"));
    const result = await folder.confirmCreating(createFn, onError);

    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(folder.selection.value).toBe("existing-folder");
    expect(folder.pending.value).toBe(false);
    expect(folder.isCreating.value).toBe(true);
    expect(folder.newFolderName.value).toBe("Invalid/Folder");
  });

  it("rejects confirmCreating with empty folder name", async () => {
    const folder = useSaveSqlFolderSelection("existing-folder");
    folder.startCreating();
    folder.newFolderName.value = "   ";

    const createFn = vi.fn();
    const result = await folder.confirmCreating(createFn);

    expect(result).toBe(false);
    expect(createFn).not.toHaveBeenCalled();
    expect(folder.isCreating.value).toBe(true);
  });

  it("resets inline folder creation state on reset and invalidate", () => {
    const folder = useSaveSqlFolderSelection("existing-folder");
    folder.startCreating();
    folder.newFolderName.value = "test-folder";

    folder.reset("other-folder");
    expect(folder.isCreating.value).toBe(false);
    expect(folder.newFolderName.value).toBe("");
    expect(folder.selection.value).toBe("other-folder");

    folder.startCreating();
    folder.newFolderName.value = "another-folder";
    folder.invalidate();
    expect(folder.isCreating.value).toBe(false);
    expect(folder.newFolderName.value).toBe("");
  });
});
