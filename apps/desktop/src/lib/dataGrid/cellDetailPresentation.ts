import { safeJsonFormat } from "@/lib/common/safeJsonFormat";

export type CellDetailTab = "details" | "hexViewer" | "valueEditor";
export type ValueEditorAction = "formatJson" | "setNull" | "restoreOriginal";

export const CELL_DETAIL_JSON_FORMAT_MAX_LENGTH = 50_000;

export interface CellDetailPresentationOptions {
  isEditable: boolean;
  hasBinaryHexViewer?: boolean;
}

export interface LinkedCellDetailOptions {
  isOpen: boolean;
  isEditing: boolean;
  selectedCell: { rowIndex: number; visibleColIndex: number } | null;
  actualColumnIndex: (visibleColIndex: number) => number;
}

export interface CellDetailTarget {
  rowIndex: number;
  col: number;
}

export function defaultCellDetailTab(): CellDetailTab {
  return "details";
}

export function visibleCellDetailTabs(options: CellDetailPresentationOptions): CellDetailTab[] {
  const tabs: CellDetailTab[] = ["details"];
  if (options.hasBinaryHexViewer) {
    tabs.push("hexViewer");
  }
  if (options.isEditable) {
    tabs.push("valueEditor");
  }
  return tabs;
}

export function cellDetailEditorText(value: unknown, _columnType?: string): string {
  if (value === null) return "";
  return cellDetailRawEditorText(value);
}

function cellDetailRawEditorText(value: unknown): string {
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function valueEditorActions(options: { canSetNull: boolean; canFormatJson?: boolean }): ValueEditorAction[] {
  const actions: ValueEditorAction[] = [];
  if (options.canFormatJson) actions.push("formatJson");
  if (options.canSetNull) actions.push("setNull");
  actions.push("restoreOriginal");
  return actions;
}

export function linkedCellDetailTarget(options: LinkedCellDetailOptions): CellDetailTarget | null {
  if (!options.isOpen || options.isEditing || !options.selectedCell) return null;
  return {
    rowIndex: options.selectedCell.rowIndex,
    col: options.actualColumnIndex(options.selectedCell.visibleColIndex),
  };
}

export function isJsonColumnType(columnType: string | undefined): boolean {
  const base = (columnType ?? "")
    .trim()
    .toLowerCase()
    .split(/[(:\s]/)[0];
  return base === "json" || base === "jsonb";
}

export function isGeometryColumnType(columnType: string | undefined): boolean {
  const base = (columnType ?? "")
    .trim()
    .toLowerCase()
    .split(/[(:\s]/)[0];
  return base === "geometry" || base === "geography";
}

export function canFormatCellDetailJson(value: unknown, columnType?: string): boolean {
  if (value === null || value === undefined) return false;
  const text = cellDetailRawEditorText(value);
  if (text.length > CELL_DETAIL_JSON_FORMAT_MAX_LENGTH) return false;
  if (isJsonColumnType(columnType)) return !!formatJsonText(text);
  return typeof value === "string" && looksLikeJsonContainerText(text) && !!formatJsonText(text);
}

export function formatJsonText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > CELL_DETAIL_JSON_FORMAT_MAX_LENGTH) return undefined;
  try {
    return safeJsonFormat(trimmed, 2);
  } catch {
    return undefined;
  }
}

export function compactJsonText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > CELL_DETAIL_JSON_FORMAT_MAX_LENGTH) return undefined;
  try {
    return safeJsonFormat(trimmed);
  } catch {
    return undefined;
  }
}

export function looksLikeJsonContainerText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
