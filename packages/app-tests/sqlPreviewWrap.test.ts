import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sqlPreviewSource = readFileSync("apps/desktop/src/components/editor/SqlPreviewPanel.vue", "utf8");
const sqlHighlighterSource = readFileSync("apps/desktop/src/lib/sql/sqlHighlighter.ts", "utf8");

describe("SQL preview wrapping", () => {
  it("renders highlighted SQL inline inside a wrapping preformatted block", () => {
    expect(sqlPreviewSource).toContain('themePreset: "preview"');
    expect(sqlHighlighterSource).toContain('structure: "inline"');
    expect(sqlPreviewSource).toContain('<pre v-else-if="highlightedHtml"');
    expect(sqlPreviewSource).toContain("whitespace-pre-wrap break-words");
    expect(sqlPreviewSource).toContain('v-html="highlightedHtml"');
  });
});
