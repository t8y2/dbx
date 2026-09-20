import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

function functionSource(name: string, nextName: string): string {
  const start = dataGridSource.indexOf(`function ${name}`);
  const relativeEnd = dataGridSource.slice(start).search(new RegExp(`\\n(?:async\\s+)?function\\s+${nextName}\\b`));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(relativeEnd).toBeGreaterThan(0);
  return dataGridSource.slice(start, start + relativeEnd);
}

describe("DataGrid large-value replacement", () => {
  it("counts preview matches and resolves full values before staging replacements", () => {
    const eligibilitySource = functionSource("canReplaceGridCell", "replacementCellInScope");
    const replaceSource = functionSource("replaceGridMatches", "fillSelectionWithValue");

    expect(eligibilitySource).not.toContain("!isLargeValuePreview");
    expect(replaceSource).toContain("await prepareDataGridCellReplacements");
    expect(replaceSource).toContain("resolveLargeValueCells");
  });
});
