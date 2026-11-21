// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { getSavedSqlExpandedFolderIds, saveSavedSqlExpandedFolderIds, SQL_LIBRARY_EXPANDED_FOLDERS_STORAGE_KEY } from "../savedSqlUiState";

describe("savedSqlUiState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty set when no expanded folder IDs have been persisted", () => {
    expect(getSavedSqlExpandedFolderIds()).toEqual(new Set());
  });

  it("persists and restores expanded folder IDs", () => {
    saveSavedSqlExpandedFolderIds(new Set(["folder-1", "folder-2"]));
    expect(getSavedSqlExpandedFolderIds()).toEqual(new Set(["folder-1", "folder-2"]));
  });

  it("handles corrupted or invalid storage values safely", () => {
    localStorage.setItem(SQL_LIBRARY_EXPANDED_FOLDERS_STORAGE_KEY, "not-json");
    expect(getSavedSqlExpandedFolderIds()).toEqual(new Set());

    localStorage.setItem(SQL_LIBRARY_EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify({ not: "an array" }));
    expect(getSavedSqlExpandedFolderIds()).toEqual(new Set());

    localStorage.setItem(SQL_LIBRARY_EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify(["valid", 123, null]));
    expect(getSavedSqlExpandedFolderIds()).toEqual(new Set(["valid"]));
  });
});
