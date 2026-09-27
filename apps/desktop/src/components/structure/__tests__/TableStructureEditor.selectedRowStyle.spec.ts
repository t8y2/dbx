import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../TableStructureEditor.vue", import.meta.url), "utf8");
const scopedStyleStart = source.indexOf("<style scoped>");
const scopedStyleEnd = source.indexOf("</style>", scopedStyleStart);
const scopedStyle = source.slice(scopedStyleStart, scopedStyleEnd).replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...scopedStyle.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1]!.split(",").map((selector) => selector.trim()),
  declarations: match[2]!,
}));

describe("TableStructureEditor selected-row styles", () => {
  it("keeps the highlight on cells without repainting descendant controls", () => {
    const selectedBackgroundRules = rules.filter(({ selectors, declarations }) => selectors.some((selector) => selector.includes(".structure-column-search-current")) && /background(?:-color)?\s*:/.test(declarations));

    expect(selectedBackgroundRules).toHaveLength(1);
    expect(selectedBackgroundRules[0]?.selectors).toEqual([".structure-column-search-current > td"]);
    expect(selectedBackgroundRules[0]?.declarations).toContain("var(--primary)");

    const gridControlRule = rules.find(({ selectors }) => selectors.includes(".structure-edit-grid :deep(.structure-grid-control)"));
    expect(gridControlRule?.declarations).toContain("background-color: transparent;");
  });
});
