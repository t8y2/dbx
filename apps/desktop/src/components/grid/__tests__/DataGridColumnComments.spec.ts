import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid column comments", () => {
  it("uses source column metadata for both inline and tooltip header comments", () => {
    expect(dataGridSource).toMatch(/function resolvedColumnComment\(column: string, actualColIdx: number\)[\s\S]*?dataGridColumnCommentFor\([\s\S]*?props\.sourceColumns\?\.\[actualColIdx\][\s\S]*?\);\s*\}/);
    expect(dataGridSource).toContain(':column-comment="headerColumnComment(col.name, col.actualColIdx)"');
    expect(dataGridSource).toContain(':tooltip-column-comment="resolvedColumnComment(col.name, col.actualColIdx)"');
    expect(dataGridSource).toContain("(column, index) => headerColumnComment(column, index)");
  });
});
