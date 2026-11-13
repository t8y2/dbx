import type { ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";
import { DiagnosticReadStopped } from "./sessionDiagnosticReader";

export type DiagnosticEngine = "oracle" | "oceanbase-oracle";
export type DiagnosticState = "loading" | "ready" | "empty" | "unavailable" | "failed" | "cancelled" | "timeout";
export type DiagnosticReason = "permission_denied" | "view_unavailable" | "field_unavailable" | "target_missing" | "target_changed" | "not_collected" | "incomplete" | "failed";
export interface DiagnosticSection<T> {
  state: DiagnosticState;
  source: string;
  sampledAt: string;
  dataSampledAt?: string;
  data?: T;
  reason?: DiagnosticReason;
  error?: string;
  incomplete?: boolean;
}
export interface DiagnosticSql {
  text: string;
  completeness: "complete" | "fragment" | "unknown" | "template";
}
export interface DiagnosticMetric {
  name: string;
  value: string | null;
  unit: "count" | "rows" | "blocks" | "microseconds" | "seconds";
  scope: "cursor_cumulative" | "plan_cumulative" | "request" | "session_sample";
  source: string;
}
export interface DiagnosticPlan {
  plan: ParsedExplainPlan;
  table: QueryResult;
  binding: "cursor" | "request" | "same_sql";
}
export interface DiagnosticChoice {
  key: string;
  identity: Record<string, string>;
}
export interface SessionDiagnosticsSnapshot {
  engine: DiagnosticEngine;
  identity: Record<string, string>;
  stale: boolean;
  startedAt?: string;
  finishedAt?: string;
  interrupted?: "cancelled" | "timeout";
  sql: DiagnosticSection<DiagnosticSql>;
  plan: DiagnosticSection<DiagnosticPlan>;
  metrics: DiagnosticSection<DiagnosticMetric[]>;
  waits: DiagnosticSection<QueryResult>;
  longOperations: DiagnosticSection<QueryResult>;
  requestChoices: DiagnosticChoice[];
  planChoices: DiagnosticChoice[];
}
export type DiagnosticPublish = (patch: Partial<SessionDiagnosticsSnapshot>) => void;
export interface DiagnosticSelection {
  requestKey?: string;
  planKey?: string;
}

export function diagnosticSection<T>(source: string, data: T, incomplete = false): DiagnosticSection<T> {
  return { state: "ready", source, sampledAt: new Date().toISOString(), data, ...(incomplete ? { incomplete: true } : {}) };
}

export function diagnosticUnavailable<T>(source: string, reason: DiagnosticReason): DiagnosticSection<T> {
  return { state: reason === "not_collected" ? "empty" : "unavailable", source, reason, sampledAt: new Date().toISOString() };
}

export function diagnosticFailure<T>(source: string, error: unknown): DiagnosticSection<T> {
  if (error instanceof DiagnosticReadStopped) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const reason = /ORA-01031/.test(message) ? "permission_denied" : /ORA-00942/.test(message) ? "view_unavailable" : /ORA-00904/.test(message) ? "field_unavailable" : "failed";
  return { state: reason === "failed" ? "failed" : "unavailable", source, reason, error: message, sampledAt: new Date().toISOString() };
}

export function diagnosticRows(result: QueryResult): Record<string, QueryResult["rows"][number][number]>[] {
  if (result.execution_error) throw new Error("Diagnostic query failed");
  return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column.toUpperCase(), row[index] ?? null])));
}

export function diagnosticString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function diagnosticInteger(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid diagnostic integer identity");
  return value.replace(/^0+(?=\d)/, "");
}

export function diagnosticLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function diagnosticResultComplete(result: QueryResult): boolean {
  return !result.truncated && !result.has_more;
}

export const DIAGNOSTIC_SECTIONS = ["sql", "plan", "metrics", "waits", "longOperations"] as const;

export function emptySessionDiagnostics(engine: DiagnosticEngine): SessionDiagnosticsSnapshot {
  const loading = { state: "loading" as const, source: "", sampledAt: "" };
  return { engine, identity: {}, stale: false, sql: { ...loading }, plan: { ...loading }, metrics: { ...loading }, waits: { ...loading }, longOperations: { ...loading }, requestChoices: [], planChoices: [] };
}

export function mergeSessionDiagnostics(previous: SessionDiagnosticsSnapshot, patch: Partial<SessionDiagnosticsSnapshot>): SessionDiagnosticsSnapshot {
  const next = { ...previous, ...patch, identity: { ...previous.identity, ...patch.identity } };
  for (const section of DIAGNOSTIC_SECTIONS) {
    const update = patch[section];
    if (!update) continue;
    const old = previous[section];
    if (update.data === undefined && old.data !== undefined) {
      Object.assign(next, { [section]: { ...update, data: old.data, dataSampledAt: old.dataSampledAt ?? old.sampledAt } });
    } else if (update.data !== undefined) Object.assign(next, { [section]: { ...update, dataSampledAt: update.dataSampledAt ?? update.sampledAt } });
  }
  return next;
}
