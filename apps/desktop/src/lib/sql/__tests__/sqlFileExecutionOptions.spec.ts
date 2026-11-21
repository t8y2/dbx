import { describe, expect, it } from "vitest";
import { SQL_FILE_CLOSE_ON_SUCCESS_STORAGE_KEY, readSqlFileCloseOnSuccess, writeSqlFileCloseOnSuccess } from "../sqlFileExecutionOptions";

describe("sqlFileExecutionOptions", () => {
  function createMockStorage(initial: Record<string, string> = {}): Storage {
    const store = new Map<string, string>(Object.entries(initial));
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    };
  }

  describe("readSqlFileCloseOnSuccess", () => {
    // Results must stay visible by default: auto-closing hid the execution outcome entirely (#14078).
    it("defaults to false when storage is unpopulated", () => {
      const storage = createMockStorage();
      expect(readSqlFileCloseOnSuccess(storage)).toBe(false);
    });

    it("defaults to false when storage is undefined", () => {
      expect(readSqlFileCloseOnSuccess(undefined)).toBe(false);
    });

    it("returns true when stored value is true", () => {
      const storage = createMockStorage({ [SQL_FILE_CLOSE_ON_SUCCESS_STORAGE_KEY]: "true" });
      expect(readSqlFileCloseOnSuccess(storage)).toBe(true);
    });

    it("returns false when stored value is false", () => {
      const storage = createMockStorage({ [SQL_FILE_CLOSE_ON_SUCCESS_STORAGE_KEY]: "false" });
      expect(readSqlFileCloseOnSuccess(storage)).toBe(false);
    });

    it("falls back to false when storage throws an exception", () => {
      const errorStorage = {
        getItem: () => {
          throw new Error("SecurityError: access denied");
        },
      } as unknown as Storage;
      expect(readSqlFileCloseOnSuccess(errorStorage)).toBe(false);
    });
  });

  describe("writeSqlFileCloseOnSuccess", () => {
    it("persists true to storage", () => {
      const storage = createMockStorage();
      writeSqlFileCloseOnSuccess(true, storage);
      expect(storage.getItem(SQL_FILE_CLOSE_ON_SUCCESS_STORAGE_KEY)).toBe("true");
    });

    it("persists false to storage", () => {
      const storage = createMockStorage();
      writeSqlFileCloseOnSuccess(false, storage);
      expect(storage.getItem(SQL_FILE_CLOSE_ON_SUCCESS_STORAGE_KEY)).toBe("false");
    });

    it("gracefully catches storage exceptions", () => {
      const errorStorage = {
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      } as unknown as Storage;
      expect(() => writeSqlFileCloseOnSuccess(false, errorStorage)).not.toThrow();
    });
  });
});
