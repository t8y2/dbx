import { diffChars, diffLines, type Change } from "diff";
import { formatJsonSource } from "@/lib/common/safeJsonFormat";
import { formatXmlSource } from "@/lib/common/xmlFormat";
import type { QueryResult } from "@/types/database";
import type { DoltDiffColumnKind, DoltRowChangeKind } from "@/lib/dolt/doltVersionControl";

export type DoltCellValue = QueryResult["rows"][number][number];
export type DoltCellSide = "before" | "after";
export type DoltCellFormat = "raw" | "json" | "xml";
export type DoltCellFormatMode = "auto" | DoltCellFormat;
export type DoltCellValueState = "value" | "row-missing" | "column-missing";
export type DoltTextDiffKind = "equal" | "added" | "removed" | "modified";

export interface DoltDiffCellTarget {
  rowIndex: number;
  columnIndex: number;
  side: DoltCellSide;
  columnName: string;
  columnKind: DoltDiffColumnKind;
  rowKind: DoltRowChangeKind;
  beforeValue: DoltCellValue;
  afterValue: DoltCellValue;
}

export interface DoltCellDisplayValue {
  state: DoltCellValueState;
  text: string;
  rawText: string;
  canFormat: boolean;
}

export interface DoltCellFormatResult {
  text: string;
  error: string | null;
}

export interface DoltTextDiffSegment {
  text: string;
  changed: boolean;
}

export interface DoltTextDiffRow {
  kind: DoltTextDiffKind;
  beforeLineNumber: number | null;
  afterLineNumber: number | null;
  beforeText: string;
  afterText: string;
  beforeSegments: DoltTextDiffSegment[];
  afterSegments: DoltTextDiffSegment[];
}

const MAX_DETAILED_LINE_DIFF_CHARACTERS = 500_000;
const MAX_CHARACTER_DIFF_CHARACTERS = 20_000;

export function doltCellValueState(target: DoltDiffCellTarget, side: DoltCellSide): DoltCellValueState {
  if (side === "before") {
    if (target.columnKind === "added") return "column-missing";
    if (target.rowKind === "added") return "row-missing";
  } else {
    if (target.columnKind === "removed") return "column-missing";
    if (target.rowKind === "removed") return "row-missing";
  }
  return "value";
}

export function doltCellDisplayValue(target: DoltDiffCellTarget, side: DoltCellSide, labels: { nullValue: string; rowMissing: string; columnMissing: string }): DoltCellDisplayValue {
  const state = doltCellValueState(target, side);
  if (state === "row-missing") return { state, text: labels.rowMissing, rawText: "", canFormat: false };
  if (state === "column-missing") return { state, text: labels.columnMissing, rawText: "", canFormat: false };
  const value = side === "before" ? target.beforeValue : target.afterValue;
  if (value === null) return { state, text: labels.nullValue, rawText: "", canFormat: false };
  const text = String(value);
  return { state, text, rawText: text, canFormat: typeof value === "string" };
}

export function formatDoltCellText(value: DoltCellDisplayValue, format: DoltCellFormat): DoltCellFormatResult {
  if (format === "raw" || !value.canFormat) return { text: value.text, error: null };
  try {
    return {
      text: format === "json" ? formatJsonSource(value.rawText, 2) : formatXmlSource(value.rawText, "  "),
      error: null,
    };
  } catch (error) {
    return { text: value.text, error: error instanceof Error ? error.message : String(error) };
  }
}

export function detectDoltCellFormat(values: readonly DoltCellDisplayValue[]): DoltCellFormat {
  const candidates = values.filter((value) => value.canFormat && value.rawText.trim()).map((value) => value.rawText.trim());
  const jsonCandidates = candidates.filter((value) => value.startsWith("{") || value.startsWith("["));
  const xmlCandidates = candidates.filter((value) => value.startsWith("<"));
  const hasValidJson = jsonCandidates.some((value) => !formatDoltCellText({ state: "value", text: value, rawText: value, canFormat: true }, "json").error);
  const hasValidXml = xmlCandidates.some((value) => !formatDoltCellText({ state: "value", text: value, rawText: value, canFormat: true }, "xml").error);
  if (hasValidJson !== hasValidXml) return hasValidJson ? "json" : "xml";
  return "raw";
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function linesFromChange(change: Change): string[] {
  if (!change.value) return [];
  const lines = change.value.split("\n");
  if (change.value.endsWith("\n")) lines.pop();
  return lines;
}

function unchangedSegments(text: string): DoltTextDiffSegment[] {
  return text ? [{ text, changed: false }] : [];
}

function changedSegments(beforeText: string, afterText: string): { before: DoltTextDiffSegment[]; after: DoltTextDiffSegment[] } {
  if (beforeText.length + afterText.length > MAX_CHARACTER_DIFF_CHARACTERS) {
    return {
      before: beforeText ? [{ text: beforeText, changed: true }] : [],
      after: afterText ? [{ text: afterText, changed: true }] : [],
    };
  }
  const changes = diffChars(beforeText, afterText);
  return {
    before: changes.filter((change) => !change.added).map((change) => ({ text: change.value, changed: !!change.removed })),
    after: changes.filter((change) => !change.removed).map((change) => ({ text: change.value, changed: !!change.added })),
  };
}

function appendEqualRows(rows: DoltTextDiffRow[], lines: string[], beforeLine: { value: number }, afterLine: { value: number }) {
  for (const line of lines) {
    rows.push({
      kind: "equal",
      beforeLineNumber: beforeLine.value++,
      afterLineNumber: afterLine.value++,
      beforeText: line,
      afterText: line,
      beforeSegments: unchangedSegments(line),
      afterSegments: unchangedSegments(line),
    });
  }
}

function appendChangedRows(rows: DoltTextDiffRow[], removed: string[], added: string[], beforeLine: { value: number }, afterLine: { value: number }) {
  const count = Math.max(removed.length, added.length);
  for (let index = 0; index < count; index += 1) {
    const beforeText = removed[index];
    const afterText = added[index];
    if (beforeText !== undefined && afterText !== undefined) {
      const segments = changedSegments(beforeText, afterText);
      rows.push({
        kind: beforeText === afterText ? "equal" : "modified",
        beforeLineNumber: beforeLine.value++,
        afterLineNumber: afterLine.value++,
        beforeText,
        afterText,
        beforeSegments: beforeText === afterText ? unchangedSegments(beforeText) : segments.before,
        afterSegments: beforeText === afterText ? unchangedSegments(afterText) : segments.after,
      });
    } else if (beforeText !== undefined) {
      rows.push({
        kind: "removed",
        beforeLineNumber: beforeLine.value++,
        afterLineNumber: null,
        beforeText,
        afterText: "",
        beforeSegments: unchangedSegments(beforeText),
        afterSegments: [],
      });
    } else if (afterText !== undefined) {
      rows.push({
        kind: "added",
        beforeLineNumber: null,
        afterLineNumber: afterLine.value++,
        beforeText: "",
        afterText,
        beforeSegments: [],
        afterSegments: unchangedSegments(afterText),
      });
    }
  }
}

function buildFallbackRows(before: string, after: string): DoltTextDiffRow[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const rows: DoltTextDiffRow[] = [];
  appendChangedRows(rows, beforeLines, afterLines, { value: 1 }, { value: 1 });
  return rows;
}

export function buildDoltTextDiff(beforeValue: string, afterValue: string): DoltTextDiffRow[] {
  const before = normalizeLineEndings(beforeValue);
  const after = normalizeLineEndings(afterValue);
  if (before.length + after.length > MAX_DETAILED_LINE_DIFF_CHARACTERS) return buildFallbackRows(before, after);

  const changes = diffLines(before, after, { newlineIsToken: false });
  const rows: DoltTextDiffRow[] = [];
  const beforeLine = { value: 1 };
  const afterLine = { value: 1 };
  let index = 0;
  while (index < changes.length) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      appendEqualRows(rows, linesFromChange(change), beforeLine, afterLine);
      index += 1;
      continue;
    }

    const removed: string[] = [];
    const added: string[] = [];
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      const changedLines = linesFromChange(changes[index]);
      if (changes[index].removed) removed.push(...changedLines);
      else added.push(...changedLines);
      index += 1;
    }
    appendChangedRows(rows, removed, added, beforeLine, afterLine);
  }

  if (rows.length === 0) appendEqualRows(rows, [""], beforeLine, afterLine);
  return rows;
}

export function doltCellCopyText(target: DoltDiffCellTarget, side: DoltCellSide): string | null {
  if (doltCellValueState(target, side) !== "value") return null;
  const value = side === "before" ? target.beforeValue : target.afterValue;
  return value === null ? "" : String(value);
}
