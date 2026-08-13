import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid transpose presentation", () => {
  it("renders field metadata and index indicator on separate lines in the pinned transpose column", () => {
    expect(dataGridSource).toContain(':item-size="transposeRowHeight"');
    expect(dataGridSource).toContain("data-grid-transpose-type-line");
    expect(dataGridSource).toContain("data-grid-transpose-comment-line");
    expect(dataGridSource).toContain("data-grid-transpose-index-indicator");
    expect(dataGridSource).toContain("showColumnTypesInHeader && item.type");
    expect(dataGridSource).toContain("showColumnCommentsInHeader && item.comment");
    expect(dataGridSource).toContain("transposeColumnIndexKind(item.column)");
  });

  it("shows complete long metadata in a hoverable, bounded tooltip", () => {
    expect(dataGridSource).toContain("data-grid-transpose-field-tooltip");
    expect(dataGridSource).toContain(':text="transposeFieldTitle(item)"');
    expect(dataGridSource).toContain('side="right"');
    expect(dataGridSource).toContain("max-h-[min(20rem,calc(100vh-1rem))]");
    expect(dataGridSource).toContain("w-[min(24rem,calc(100vw-1rem))]");
    expect(dataGridSource).toContain("overflow-auto rounded-md");
    expect(dataGridSource).toContain("whitespace-pre-wrap break-words select-text");
    expect(dataGridSource).not.toContain("data-grid-transpose-field-popover");
  });
});
