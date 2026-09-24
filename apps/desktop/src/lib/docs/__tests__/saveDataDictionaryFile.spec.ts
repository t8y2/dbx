import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDictionaryExportPath } from "@/lib/docs/dataDictionary";

describe("saveDataDictionaryFile", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/backend/tauriRuntime");
    vi.doUnmock("@tauri-apps/plugin-dialog");
    vi.doUnmock("@tauri-apps/plugin-fs");
  });

  async function loadSaver(save: ReturnType<typeof vi.fn>, writeFile: ReturnType<typeof vi.fn>, exists: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ save }));
    vi.doMock("@tauri-apps/plugin-fs", () => ({ writeFile, exists }));
    return import("../saveDataDictionaryFile");
  }

  it("writes only the path the save dialog just returned, after stamping the suggested name", async () => {
    const save = vi.fn().mockResolvedValue("/granted/shop.pdf");
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const exists = vi.fn().mockResolvedValue(false);
    const { saveDataDictionaryFile } = await loadSaver(save, writeFile, exists);
    const suggested = resolveDictionaryExportPath("/typed/shop.pdf", "shop-data-dictionary.pdf", true, new Date("2026-09-24T14:05:06"));
    const bytes = new Uint8Array([37, 80, 68, 70]);

    await saveDataDictionaryFile(suggested, bytes, { overwrite: true });

    expect(save).toHaveBeenCalledWith({
      defaultPath: "/typed/shop_20260924140506.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]?.[0]).toBe("/granted/shop.pdf");
    expect(writeFile.mock.calls[0]?.[0]).not.toBe(suggested);
    expect(exists).not.toHaveBeenCalled();
  });

  it("refuses to write a granted path that already exists when overwrite is off", async () => {
    const save = vi.fn().mockResolvedValue("/granted/shop.pdf");
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const exists = vi.fn().mockResolvedValue(true);
    const { saveDataDictionaryFile, DictionaryFileExistsError } = await loadSaver(save, writeFile, exists);

    await expect(saveDataDictionaryFile("shop-data-dictionary.pdf", new Uint8Array([1]), { overwrite: false })).rejects.toBeInstanceOf(DictionaryFileExistsError);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
