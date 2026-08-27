import { formatJsonSource } from "@/lib/common/safeJsonFormat";
import { buildTextDiff, type TextDiffKind, type TextDiffRow, type TextDiffSegment } from "@/lib/common/textDiff";
import { formatXmlSource } from "@/lib/common/xmlFormat";
import type { QueryResult } from "@/types/database";
import type { DoltDiffColumnKind, DoltRowChangeKind } from "@/lib/dolt/doltVersionControl";

export type DoltCellValue = QueryResult["rows"][number][number];
export type DoltCellSide = "before" | "after";
export type DoltCellFormat = "raw" | "json" | "xml";
export type DoltCellFormatMode = "auto" | DoltCellFormat;
export type DoltCellValueState = "value" | "row-missing" | "column-missing";
export type DoltTextDiffKind = TextDiffKind;

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

export type DoltTextDiffSegment = TextDiffSegment;
export type DoltTextDiffRow = TextDiffRow;

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

export function buildDoltTextDiff(beforeValue: string, afterValue: string): DoltTextDiffRow[] {
  return buildTextDiff(beforeValue, afterValue);
}

export function doltCellCopyText(target: DoltDiffCellTarget, side: DoltCellSide): string | null {
  if (doltCellValueState(target, side) !== "value") return null;
  const value = side === "before" ? target.beforeValue : target.afterValue;
  return value === null ? "" : String(value);
}
