import { readFileSync } from "node:fs";
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

const appSource = readFileSync(new URL("../../App.vue", import.meta.url), "utf8");

describe("save SQL folder selection", () => {
  it("keeps save and reselection blocked until folder creation completes", async () => {
    const creation = deferred<string>();
    const folder = useSaveSqlFolderSelection("existing-folder");

    const pendingSelection = folder.select("new-folder", () => creation.promise);
    await folder.select("other-folder");

    expect(folder.pending.value).toBe(true);
    expect(folder.selection.value).toBe("existing-folder");
    expect(appSource).toContain("if (saveSqlFolderCreationPending.value) return;");
    expect(appSource).toContain(':disabled="saveSqlFolderCreationPending"');
    expect(appSource).toContain(':disabled="saveSqlFolderCreationPending || !saveSqlName.trim()"');

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
});
