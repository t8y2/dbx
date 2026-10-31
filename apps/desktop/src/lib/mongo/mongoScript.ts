import { normalizeBackendError } from "@/lib/backend/errorUtils";
import type { QueryResult } from "@/types/database";

export interface MongoScriptRequest {
  connectionId: string;
  database: string;
  source: string;
  executionId?: string;
  maxRows: number;
  timeoutSecs?: number;
  dangerousOperationConfirmed: boolean;
}

export type MongoScriptOutput = { kind: "text"; value: string } | { kind: "json"; value: unknown };

export interface MongoScriptResult {
  finalValue?: unknown;
  output: MongoScriptOutput[];
  operationCount: number;
  succeededOperationCount: number;
  currentDatabase: string;
  truncated: boolean;
}

export interface MongoScriptResultLabels {
  typeColumn: string;
  valueColumn: string;
  textOutput: string;
  jsonOutput: string;
  finalValue: string;
  summary: string;
  summaryValue: (params: { succeeded: number; attempted: number; database: string }) => string;
  outputTruncated: string;
}

type MongoScriptErrorTranslate = (key: string, params?: Record<string, unknown>) => string;

export const MAX_MONGO_SCRIPT_ROWS = 10_000;

const MONGO_SCRIPT_ERROR_PATTERN = /^\[mongo_script\.([a-z_]+)\]\s*([\s\S]*)$/;
const MONGO_SCRIPT_PROGRESS_PATTERN = /\s*\(MongoDB shell progress: (\d+) confirmed completed of (\d+) attempted operations(; in-flight operation outcome unknown)?\)$/;
const LEGACY_MONGO_SCRIPT_PROGRESS_PATTERN = /\s*\(MongoDB shell stopped after (\d+) of (\d+) attempted operations succeeded\)$/;

const MONGO_SCRIPT_ERROR_KEYS: Record<string, string> = {
  cancelled: "mongoScript.errorCancelled",
  host: "mongoScript.errorHost",
  invalid_request: "mongoScript.errorInvalidRequest",
  resource_limit: "mongoScript.errorResourceLimit",
  runtime: "mongoScript.errorRuntime",
  safety: "mongoScript.errorSafety",
  serialization: "mongoScript.errorSerialization",
  timeout: "mongoScript.errorTimeout",
};

export function mongoScriptResultToQueryResult(result: MongoScriptResult, executionTimeMs: number, labels: MongoScriptResultLabels): QueryResult {
  const rows: QueryResult["rows"] = result.output.map((item) => [item.kind === "text" ? labels.textOutput : labels.jsonOutput, displayMongoScriptValue(item.value)]);
  if (Object.prototype.hasOwnProperty.call(result, "finalValue")) {
    rows.push([labels.finalValue, displayMongoScriptValue(result.finalValue)]);
  }
  rows.push([
    labels.summary,
    labels.summaryValue({
      succeeded: result.succeededOperationCount,
      attempted: result.operationCount,
      database: result.currentDatabase,
    }),
  ]);
  if (result.truncated) rows.push([labels.summary, labels.outputTruncated]);

  return {
    columns: [labels.typeColumn, labels.valueColumn],
    column_types: ["TEXT", "TEXT"],
    rows,
    affected_rows: 0,
    execution_time_ms: executionTimeMs,
    // Script output truncation is already represented by the dedicated summary
    // row above. QueryResult.truncated means a database row set can be paged or
    // re-queried, which does not apply to discarded script output.
    truncated: false,
    has_more: false,
  };
}

export function clampMongoScriptMaxRows(value: number): number {
  if (!Number.isFinite(value)) return MAX_MONGO_SCRIPT_ROWS;
  return Math.min(MAX_MONGO_SCRIPT_ROWS, Math.max(1, Math.trunc(value)));
}

export function translateMongoScriptError(t: MongoScriptErrorTranslate, error: unknown): string | null {
  const message = mongoScriptErrorMessage(error);
  const match = message.match(MONGO_SCRIPT_ERROR_PATTERN);
  if (!match) return null;

  const [, kind, rawDetail = ""] = match;
  const progress = rawDetail.match(MONGO_SCRIPT_PROGRESS_PATTERN);
  const legacyProgress = progress ? null : rawDetail.match(LEGACY_MONGO_SCRIPT_PROGRESS_PATTERN);
  const progressMatch = progress ?? legacyProgress;
  const detail = (progressMatch ? rawDetail.slice(0, progressMatch.index) : rawDetail).trim();
  const summaryKey = kind === "runtime" && /Unsupported MongoDB (?:database|collection) method:/.test(detail) ? "mongoScript.errorUnsupportedApi" : MONGO_SCRIPT_ERROR_KEYS[kind ?? ""];
  const summary = summaryKey ? t(summaryKey) : t("mongoScript.errorRuntime");
  const partial = progressMatch ? t("mongoScript.errorPartialCompletion", { succeeded: Number(progressMatch[1]), attempted: Number(progressMatch[2]) }) : "";
  const unknownOutcome = progress?.[3] ? t("mongoScript.errorUnknownOutcome") : "";
  return [summary, detail, partial, unknownOutcome].filter(Boolean).join("\n\n");
}

function mongoScriptErrorMessage(error: unknown): string {
  const structured = normalizeBackendError(error);
  if (structured?.detail) return structured.detail.trim();
  if (error instanceof Error) return error.message.trim();
  if (typeof error === "string") return error.trim();
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message.trim();
  return String(error).trim();
}

function displayMongoScriptValue(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}
