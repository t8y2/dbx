import { describe, expect, it } from "vitest";
import { applyInlineCellEditorPaste, inlineCellEditorPasteNeedsExpandedEditor } from "@/lib/dataGrid/dataGridCellEditorPaste";

describe("inlineCellEditorPasteNeedsExpandedEditor", () => {
  it("detects line feed", () => {
    expect(inlineCellEditorPasteNeedsExpandedEditor("a\nb")).toBe(true);
  });

  it("detects carriage return", () => {
    expect(inlineCellEditorPasteNeedsExpandedEditor("a\rb")).toBe(true);
  });

  it("detects CRLF", () => {
    expect(inlineCellEditorPasteNeedsExpandedEditor("a\r\nb")).toBe(true);
  });

  it("keeps single-line and empty clipboard text on the inline editor", () => {
    expect(inlineCellEditorPasteNeedsExpandedEditor("plain text")).toBe(false);
    expect(inlineCellEditorPasteNeedsExpandedEditor("")).toBe(false);
    expect(inlineCellEditorPasteNeedsExpandedEditor("tab\tseparated")).toBe(false);
  });
});

describe("applyInlineCellEditorPaste", () => {
  it("inserts at the caret of an empty value", () => {
    expect(applyInlineCellEditorPaste("", 0, 0, "a\nb")).toEqual({ value: "a\nb", caret: 3 });
  });

  it("replaces the selected range and reports the caret after the paste", () => {
    expect(applyInlineCellEditorPaste("seed-note", 5, 9, "N\nL")).toEqual({ value: "seed-N\nL", caret: 8 });
  });

  it("inserts between characters when the selection is collapsed", () => {
    expect(applyInlineCellEditorPaste("seed-note", 4, 4, "N\nL")).toEqual({ value: "seedN\nL-note", caret: 7 });
  });

  it("replaces the whole value when everything is selected", () => {
    expect(applyInlineCellEditorPaste("old", 0, 3, "x\ny")).toEqual({ value: "x\ny", caret: 3 });
  });

  it("appends to the end when no selection is reported", () => {
    expect(applyInlineCellEditorPaste("seed", null, null, "\nmore")).toEqual({ value: "seed\nmore", caret: 9 });
  });

  it("treats an out-of-range selection as the whole value", () => {
    expect(applyInlineCellEditorPaste("abc", -5, 99, "z")).toEqual({ value: "z", caret: 1 });
  });

  it("keeps the pasted text verbatim including CRLF", () => {
    expect(applyInlineCellEditorPaste("", 0, 0, "a\r\nb")).toEqual({ value: "a\r\nb", caret: 4 });
  });
});
