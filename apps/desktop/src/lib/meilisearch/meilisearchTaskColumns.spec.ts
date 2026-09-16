// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { loadMeilisearchTaskColumns, MEILISEARCH_TASK_COLUMN_KEYS, MEILISEARCH_TASK_COLUMN_STORAGE_KEY, saveMeilisearchTaskColumns } from "./meilisearchTaskColumns";

describe("Meilisearch task column persistence", () => {
  beforeEach(() => localStorage.removeItem(MEILISEARCH_TASK_COLUMN_STORAGE_KEY));

  it("shows every supported column by default", () => {
    expect(loadMeilisearchTaskColumns()).toEqual(MEILISEARCH_TASK_COLUMN_KEYS);
  });

  it("persists known visible columns in stable table order", () => {
    saveMeilisearchTaskColumns(["finishedAt", "uid", "details"]);
    expect(loadMeilisearchTaskColumns()).toEqual(["uid", "details", "finishedAt"]);
  });

  it("ignores corrupt and unknown stored values", () => {
    localStorage.setItem(MEILISEARCH_TASK_COLUMN_STORAGE_KEY, JSON.stringify({ visible: ["unknown", "status"] }));
    expect(loadMeilisearchTaskColumns()).toEqual(["status"]);
    localStorage.setItem(MEILISEARCH_TASK_COLUMN_STORAGE_KEY, "not-json");
    expect(loadMeilisearchTaskColumns()).toEqual(MEILISEARCH_TASK_COLUMN_KEYS);
  });
});
