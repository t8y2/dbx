// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRecentSqlFiles, getRecentSqlFiles, MAX_RECENT_SQL_FILES, RECENT_SQL_FILES_STORAGE_KEY, recordRecentSqlFile, relocateRecentSqlFiles } from "@/lib/sql/recentSqlFiles";

afterEach(() => {
  localStorage.removeItem(RECENT_SQL_FILES_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe("recent SQL files", () => {
  it.each(["{", "{}"])("reports invalid persisted history %s", (raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(RECENT_SQL_FILES_STORAGE_KEY, raw);

    expect(getRecentSqlFiles()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(RECENT_SQL_FILES_STORAGE_KEY);
  });

  it("records SQL paths newest-first, normalizes separators, and avoids duplicates", () => {
    recordRecentSqlFile("C:\\work\\first.sql");
    recordRecentSqlFile("C:/work/second.sql");
    recordRecentSqlFile("C:/work/first.sql");
    recordRecentSqlFile("C:/work/script.js");

    expect(getRecentSqlFiles()).toEqual(["C:/work/first.sql", "C:/work/second.sql"]);
  });

  it("limits the list and ignores malformed stored entries", () => {
    for (let index = 0; index < MAX_RECENT_SQL_FILES + 2; index += 1) {
      recordRecentSqlFile(`C:/work/query-${index}.sql`);
    }
    expect(getRecentSqlFiles()).toHaveLength(MAX_RECENT_SQL_FILES);
    expect(getRecentSqlFiles()[0]).toBe(`C:/work/query-${MAX_RECENT_SQL_FILES + 1}.sql`);

    localStorage.setItem(RECENT_SQL_FILES_STORAGE_KEY, JSON.stringify(["C:\\work\\valid.sql", 1, "notes.txt", "C:/work/valid.sql"]));
    expect(getRecentSqlFiles()).toEqual(["C:/work/valid.sql"]);
  });

  it("updates file and folder paths after renames and clears the history", () => {
    recordRecentSqlFile("C:/work/old/first.sql");
    recordRecentSqlFile("C:/work/old/second.sql");
    relocateRecentSqlFiles("C:/work/old/first.sql", "C:/work/old/renamed.sql");
    relocateRecentSqlFiles("C:/work/old", "C:/work/new", true);

    expect(getRecentSqlFiles()).toEqual(["C:/work/new/second.sql", "C:/work/new/renamed.sql"]);
    clearRecentSqlFiles();
    expect(getRecentSqlFiles()).toEqual([]);
  });
});
