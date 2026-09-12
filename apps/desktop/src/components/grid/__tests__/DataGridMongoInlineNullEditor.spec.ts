import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid Mongo inline null editor", () => {
  // #8812: keyboard-driven cell edits read the initial text from
  // inlineCellEditorText. It must translate the Mongo collection grid's
  // internal null sentinel (and escaped strings) exactly like the double-click
  // path (cellEditorTextForValue), instead of leaking the raw sentinel into
  // the editor.
  it("routes inline editor text through the Mongo document-grid translation", () => {
    expect(dataGridSource).toContain("const documentGridText = props.mongoCollectionGrid ? mongoDocumentGridEditorText(value) : undefined;");
    expect(dataGridSource).toContain("if (documentGridText !== undefined) return documentGridText;");
  });

  it("keeps the sentinel out of the raw editor fallback for grid edits", () => {
    const inlineBlock = dataGridSource.slice(dataGridSource.indexOf("function inlineCellEditorText"), dataGridSource.indexOf("function normalizeTemporalCellEditorValue"));
    expect(inlineBlock).toContain("mongoDocumentGridEditorText(value)");
  });
});
