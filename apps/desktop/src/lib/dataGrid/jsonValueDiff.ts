import { formatJsonSource } from "@/lib/common/safeJsonFormat";
import { isJsonColumnType, looksLikeJsonContainerText } from "@/lib/dataGrid/cellDetailPresentation";

export type JsonValueDiffMode = "json" | "raw";
export type JsonValueDiffFormatError = { kind: "invalid-json"; message: string } | { kind: "too-large"; limit: number };

export interface JsonValueDiffSnapshot {
  columnName: string;
  originalValue: string;
  currentValue: string;
}

export interface JsonValueDiffFormatResult {
  text: string;
  error: JsonValueDiffFormatError | null;
}

export const JSON_VALUE_DIFF_MAX_FORMAT_LENGTH = 500_000;

export interface JsonValueDiffContext {
  columnName: string;
  columnType?: string;
  originalValue: string;
  isEditable: boolean;
  isEditing: boolean;
}

export interface JsonValueDiffCandidate extends JsonValueDiffContext {
  currentValue: string;
}

function isJsonSource(value: string): boolean {
  if (!looksLikeJsonContainerText(value)) return false;
  if (value.length > JSON_VALUE_DIFF_MAX_FORMAT_LENGTH) return true;
  try {
    formatJsonSource(value, 2);
    return true;
  } catch {
    return false;
  }
}

export function isJsonValueDiffAvailable(candidate: JsonValueDiffContext): boolean {
  if (!candidate.isEditable || !candidate.isEditing) return false;
  return isJsonColumnType(candidate.columnType) || isJsonSource(candidate.originalValue);
}

export function createJsonValueDiffSnapshot(candidate: JsonValueDiffCandidate): Readonly<JsonValueDiffSnapshot> | null {
  if (!isJsonValueDiffAvailable(candidate) || candidate.originalValue === candidate.currentValue) return null;
  return Object.freeze({
    columnName: candidate.columnName,
    originalValue: candidate.originalValue,
    currentValue: candidate.currentValue,
  });
}

export function formatJsonValueDiffText(value: string, mode: JsonValueDiffMode): JsonValueDiffFormatResult {
  if (mode === "raw") return { text: value, error: null };
  if (value.length > JSON_VALUE_DIFF_MAX_FORMAT_LENGTH) {
    return { text: value, error: { kind: "too-large", limit: JSON_VALUE_DIFF_MAX_FORMAT_LENGTH } };
  }
  try {
    return { text: formatJsonSource(value, 2), error: null };
  } catch (error) {
    return {
      text: value,
      error: {
        kind: "invalid-json",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
