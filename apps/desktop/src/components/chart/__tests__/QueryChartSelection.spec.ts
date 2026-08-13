import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryChartSource = readFileSync(new URL("../QueryChart.vue", import.meta.url), "utf8");

describe("QueryChart Y-axis selection", () => {
  it("binds the visible checkbox state to the selected Y columns", () => {
    expect(queryChartSource).toContain(':model-value="yColumnIndexes.includes(col.index)"');
    expect(queryChartSource).toContain('@update:model-value="setYColumn(col.index, $event)"');
    expect(queryChartSource).not.toContain(':checked="yColumnIndexes.includes(col.index)"');
    expect(queryChartSource).not.toContain('@click="toggleYColumn(col.index)"');
    expect(queryChartSource).not.toContain("CheckIcon");
  });
});
