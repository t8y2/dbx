import { describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_EXPORT_OPTIONS, DATABASE_EXPORT_OPTIONS_STORAGE_KEY, loadSavedDatabaseExportOptions, saveDatabaseExportOptions, sortDatabaseTableNames } from "../databaseExportOptions";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
}

describe("databaseExportOptions", () => {
  it("returns default options when storage is empty or contains invalid json", () => {
    const emptyStorage = createMemoryStorage();
    expect(loadSavedDatabaseExportOptions(emptyStorage)).toEqual(DEFAULT_DATABASE_EXPORT_OPTIONS);

    const corruptStorage = createMemoryStorage({
      [DATABASE_EXPORT_OPTIONS_STORAGE_KEY]: "{ invalid json",
    });
    expect(loadSavedDatabaseExportOptions(corruptStorage)).toEqual(DEFAULT_DATABASE_EXPORT_OPTIONS);
  });

  it("saves and loads export options accurately", () => {
    const storage = createMemoryStorage();
    saveDatabaseExportOptions(
      {
        includeStructure: false,
        includeData: true,
        insertDialect: "standard",
        insertMode: "single",
        includeObjects: false,
        includeCreateDatabase: true,
        dropTableIfExists: true,
        omitAutoIncrement: true,
        preserveOriginalLanguage: true,
        splitSqlOutput: true,
        splitSqlPartMaxMb: 250,
      },
      storage,
    );

    const loaded = loadSavedDatabaseExportOptions(storage);
    expect(loaded).toEqual({
      includeStructure: false,
      includeData: true,
      insertDialect: "standard",
      insertMode: "single",
      includeObjects: false,
      includeCreateDatabase: true,
      dropTableIfExists: true,
      omitAutoIncrement: true,
      preserveOriginalLanguage: true,
      splitSqlOutput: true,
      splitSqlPartMaxMb: 250,
    });
  });

  it("preserves unmodified fields when saving partial options", () => {
    const storage = createMemoryStorage();
    saveDatabaseExportOptions({ dropTableIfExists: true }, storage);

    const loaded = loadSavedDatabaseExportOptions(storage);
    expect(loaded.dropTableIfExists).toBe(true);
    expect(loaded.includeStructure).toBe(DEFAULT_DATABASE_EXPORT_OPTIONS.includeStructure);
    expect(loaded.insertMode).toBe(DEFAULT_DATABASE_EXPORT_OPTIONS.insertMode);
  });

  it("clamps splitSqlPartMaxMb within valid bounds", () => {
    const storage = createMemoryStorage();
    saveDatabaseExportOptions({ splitSqlPartMaxMb: 99999 }, storage);
    expect(loadSavedDatabaseExportOptions(storage).splitSqlPartMaxMb).toBe(4096);

    saveDatabaseExportOptions({ splitSqlPartMaxMb: -10 }, storage);
    expect(loadSavedDatabaseExportOptions(storage).splitSqlPartMaxMb).toBe(1);
  });

  it("sorts table names alphabetically", () => {
    const unsorted = ["zoo", "alpha", "orders", "bravo", "mango", "order_items"];
    expect(sortDatabaseTableNames(unsorted)).toEqual(["alpha", "bravo", "mango", "order_items", "orders", "zoo"]);
  });
});
