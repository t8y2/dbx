import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

function functionSource(name: string, nextName: string): string {
  const start = dataGridSource.indexOf(`function ${name}`);
  const relativeEnd = dataGridSource.slice(start).search(new RegExp(`\\n(?:async\\s+)?function\\s+${nextName}\\b`));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(relativeEnd).toBeGreaterThan(0);
  const end = start + relativeEnd;
  return dataGridSource.slice(start, end);
}

describe("DataGrid infinite-scroll sorting", () => {
  it("clears completed and pending infinite-scroll state before database sorting", () => {
    const sortSource = functionSource("applyColumnSort", "selectHeaderSort");
    const resetSource = functionSource("resetInfiniteScrollState", "onToolbarRefresh");

    expect(sortSource).toContain('if (mode === "database" && infiniteScrollEnabled.value) {\n    resetInfiniteScrollState();');
    expect(resetSource).toContain("lastInfiniteScrollPage = 0;");
    expect(resetSource).toContain("infiniteScrollAllLoaded = false;");
    expect(resetSource).toContain("infiniteScrollRequestedOffset = undefined;");
    expect(resetSource).toContain("infiniteScrollRequestedLimit = undefined;");
    expect(resetSource).toContain("isInfiniteScrollPaginating.value = false;");
    expect(resetSource).toContain("infiniteScrollLoading.value = false;");
  });

  it("preserves the existing lightweight reset for local sorting", () => {
    const sortSource = functionSource("applyColumnSort", "selectHeaderSort");

    expect(sortSource).toContain("} else {\n    currentPage.value = 1;\n    resetGridVerticalScroll(true);\n  }");
    expect(sortSource.match(/emit\("sort"/g)).toHaveLength(1);
  });
});
