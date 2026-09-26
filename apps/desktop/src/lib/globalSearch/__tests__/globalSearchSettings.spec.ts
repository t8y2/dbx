import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue(undefined),
  load: vi.fn().mockResolvedValue(null),
  sqlFolders: vi.fn((): string[] => []),
}));

vi.mock("@/lib/backend/api", () => ({
  saveGlobalSearchSettings: mocks.save,
  loadGlobalSearchSettings: mocks.load,
}));

vi.mock("@/lib/sqlFile/sqlFileFolders", () => ({
  getSqlFileFolderPaths: () => mocks.sqlFolders(),
}));

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const { DEFAULT_GLOBAL_SEARCH_EXTENSIONS, getGlobalSearchExtensions, getGlobalSearchRoots, saveGlobalSearchExtensions, saveGlobalSearchRoots, composeGlobalSearchRoots, globalSearchSettingsVersion, initializeGlobalSearchSettings } = await import("../globalSearchSettings");

describe("globalSearchSettings", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
    mocks.save.mockClear();
    mocks.load.mockReset().mockResolvedValue(null);
    mocks.sqlFolders.mockReset().mockReturnValue([]);
  });

  it("defaults extensions to sql", () => {
    expect(getGlobalSearchExtensions()).toEqual(DEFAULT_GLOBAL_SEARCH_EXTENSIONS);
    expect(getGlobalSearchExtensions()).toEqual(["sql"]);
  });

  it("normalizes extensions (dot prefix, case, whitespace, dedupe) and persists to disk", () => {
    const versionBefore = globalSearchSettingsVersion.value;
    saveGlobalSearchExtensions([" .SQL ", "Txt", "sql", ""]);
    expect(getGlobalSearchExtensions()).toEqual(["sql", "txt"]);
    expect(globalSearchSettingsVersion.value).toBe(versionBefore + 1);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith({ roots: [], extensions: ["sql", "txt"] });
  });

  it("falls back to default extensions when the list becomes empty", () => {
    saveGlobalSearchExtensions(["   ", "."]);
    expect(getGlobalSearchExtensions()).toEqual(["sql"]);
  });

  it("saves roots, dropping blank entries, and persists to disk", () => {
    const versionBefore = globalSearchSettingsVersion.value;
    saveGlobalSearchRoots([" D:\\work\\sql ", "", "E:\\docs"]);
    expect(getGlobalSearchRoots()).toEqual(["D:\\work\\sql", "E:\\docs"]);
    expect(globalSearchSettingsVersion.value).toBe(versionBefore + 1);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith({ roots: ["D:\\work\\sql", "E:\\docs"], extensions: ["sql"] });
  });

  it("composes SQL folders plus extra roots without duplicates", () => {
    mocks.sqlFolders.mockReturnValue(["D:\\sql", "D:\\shared"]);
    saveGlobalSearchRoots(["D:\\shared", "E:\\extra", " "]);
    expect(composeGlobalSearchRoots()).toEqual(["D:\\sql", "D:\\shared", "E:\\extra"]);
  });

  it("hydrates roots and extensions from the disk store", async () => {
    mocks.load.mockResolvedValue({
      roots: ["D:\\disk-root"],
      extensions: [".sql", "txt"],
    });
    await initializeGlobalSearchSettings();
    expect(getGlobalSearchRoots()).toEqual(["D:\\disk-root"]);
    expect(getGlobalSearchExtensions()).toEqual(["sql", "txt"]);
    // Hydration re-persists the normalized values back to disk.
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenLastCalledWith({ roots: ["D:\\disk-root"], extensions: ["sql", "txt"] });
  });

  it("keeps current values when the disk store is empty", async () => {
    saveGlobalSearchRoots(["D:\\keep"]);
    await initializeGlobalSearchSettings();
    expect(getGlobalSearchRoots()).toEqual(["D:\\keep"]);
  });

  it("ignores malformed disk payloads", async () => {
    saveGlobalSearchExtensions(["sql"]);
    mocks.load.mockResolvedValue({ roots: "not-an-array", extensions: 42 });
    await initializeGlobalSearchSettings();
    expect(getGlobalSearchRoots()).toEqual([]);
    expect(getGlobalSearchExtensions()).toEqual(["sql"]);
  });
});
