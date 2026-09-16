// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { loadMeilisearchKeyColumns, MEILISEARCH_KEY_COLUMN_KEYS, MEILISEARCH_KEY_COLUMN_STORAGE_KEY, saveMeilisearchKeyColumns } from "./meilisearchKeyColumns";

describe("Meilisearch key column persistence", () => {
  beforeEach(() => localStorage.removeItem(MEILISEARCH_KEY_COLUMN_STORAGE_KEY));

  it("uses all columns by default", () => {
    expect(loadMeilisearchKeyColumns()).toEqual(MEILISEARCH_KEY_COLUMN_KEYS);
  });

  it("stores valid columns in canonical order", () => {
    saveMeilisearchKeyColumns(["expiresAt", "name", "key"]);
    expect(loadMeilisearchKeyColumns()).toEqual(["name", "key", "expiresAt"]);
  });

  it("falls back safely for invalid persisted data", () => {
    localStorage.setItem(MEILISEARCH_KEY_COLUMN_STORAGE_KEY, "invalid");
    expect(loadMeilisearchKeyColumns()).toEqual(MEILISEARCH_KEY_COLUMN_KEYS);
  });
});
