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

  it("keeps HeidiSQL-style column type and key tone hooks wired", () => {
    expect(source).toContain("structureDataTypeToneClass(column.dataType)");
    expect(source).toContain("structure-column-primary-key");
    expect(source).toContain("structure-column-unique-key");

    for (const className of ["structure-data-type-numeric", "structure-data-type-text", "structure-data-type-temporal", "structure-data-type-json", "structure-data-type-binary", "structure-data-type-boolean", "structure-data-type-enum", "structure-data-type-spatial"]) {
      expect(scopedStyle).toContain(className);
    }
  });

  it("guards index column options and column issues against hot-path recalculations (#11637)", () => {
    expect(source).toContain("canIndexTypeHaveSpecialIssue(structureDialect.value, indexType)");
    expect(source).toContain("canIndexTypeHaveSpecialIssue(structureDialect.value, index.indexType)");
    expect(source).toContain("defaultIndexColumnOptions = computed");
    expect(source).toContain("activeColumnByName = computed");
    expect(source).toContain("activeColumnByComparisonKey = computed");
    expect(source).toContain("indexesByColumnComparisonKey = computed");
  });
});
