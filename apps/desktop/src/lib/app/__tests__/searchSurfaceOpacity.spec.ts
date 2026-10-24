import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * When wallpaper is active with high transparency, `--background` receives alpha
 * and turns translucent. In-page search boxes should remain solid on focus so
 * inputs and text remain clearly readable (#11511).
 */
const SEARCH_COMPONENTS = {
  "editor/EditorSearchPanel.vue": "../../../components/editor/EditorSearchPanel.vue",
  "editor/EditorGotoLinePanel.vue": "../../../components/editor/EditorGotoLinePanel.vue",
  "grid/DataGridSearchBar.vue": "../../../components/grid/DataGridSearchBar.vue",
  "common/TextContentSearchBar.vue": "../../../components/common/TextContentSearchBar.vue",
} as const;

describe("in-page search surfaces under wallpaper (#11511)", () => {
  for (const [label, relativePath] of Object.entries(SEARCH_COMPONENTS)) {
    it(`${label} switches to solid background on focus`, () => {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).toMatch(/focus(-within)?:\S*bg-background-solid/);
    });
  }

  it("EditorSearchPanel scoped editor tone defines solid background on focus", () => {
    const source = readFileSync(new URL("../../../components/editor/EditorSearchPanel.vue", import.meta.url), "utf8");
    expect(source).toMatch(/\.editor-search-panel--editor\s+:deep\(\.border-input:focus-within\)\s*\{\s*background:\s*var\(--background-solid,\s*var\(--background\)\);/);
  });
});
