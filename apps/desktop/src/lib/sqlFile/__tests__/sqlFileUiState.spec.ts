// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { getSqlFileFoldersUiState, saveSqlFileFoldersUiState, SQL_FILE_FOLDERS_UI_STATE_STORAGE_KEY } from "../sqlFileUiState";

describe("sqlFileUiState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty object when no state has been saved", () => {
    expect(getSqlFileFoldersUiState()).toEqual({});
  });

  it("persists and restores folder UI state including collapsed roots and expanded subdirectories", () => {
    saveSqlFileFoldersUiState({
      "/project/sql": {
        collapsed: false,
        expanded: ["/project/sql/migrations", "/project/sql/seeds"],
      },
      "/other/scripts": {
        collapsed: true,
        expanded: [],
      },
    });

    const restored = getSqlFileFoldersUiState();
    expect(restored).toEqual({
      "/project/sql": {
        collapsed: false,
        expanded: ["/project/sql/migrations", "/project/sql/seeds"],
      },
      "/other/scripts": {
        collapsed: true,
        expanded: [],
      },
    });
  });

  it("sanitizes corrupted localStorage values gracefully", () => {
    localStorage.setItem(SQL_FILE_FOLDERS_UI_STATE_STORAGE_KEY, "{ broken json");
    expect(getSqlFileFoldersUiState()).toEqual({});

    localStorage.setItem(SQL_FILE_FOLDERS_UI_STATE_STORAGE_KEY, "[]");
    expect(getSqlFileFoldersUiState()).toEqual({});

    localStorage.setItem(
      SQL_FILE_FOLDERS_UI_STATE_STORAGE_KEY,
      JSON.stringify({
        "/path": { collapsed: "invalid", expanded: [123, "/path/valid"] },
        invalidEntry: "not an object",
      }),
    );
    expect(getSqlFileFoldersUiState()).toEqual({
      "/path": {
        collapsed: false,
        expanded: ["/path/valid"],
      },
    });
  });
});
