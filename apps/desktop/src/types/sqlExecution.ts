import type { DatabaseType } from "@/types/database";

export interface MultiDbExecutionTarget {
  connectionId: string;
  catalog?: string;
  database: string;
  schema?: string;
}

export interface SqlExecutionTargetGroup {
  id: string;
  name: string;
  databaseType: DatabaseType;
  targets: MultiDbExecutionTarget[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export type SqlExecutionTargetValidationState = "valid" | "invalid" | "needsRecheck";

export type MultiDbExecutionItemStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled" | "not_executed";

export interface MultiDbResultRunExecution {
  kind: "multi-db";
  batchId: string;
  target: MultiDbExecutionTarget;
  title?: string;
  status: MultiDbExecutionItemStatus;
  durationMs?: number;
  errorMessage?: string;
}

export interface MultiDbTargetExecutionResult {
  status: Exclude<MultiDbExecutionItemStatus, "pending" | "running" | "not_executed">;
  errorMessage?: string;
  durationMs?: number;
}

export interface SqlExecutionTargetValidation {
  target: MultiDbExecutionTarget;
  state: SqlExecutionTargetValidationState;
  reason?: string;
}

/** Resolves the effective database type for a persisted execution target. */
export type SqlExecutionTargetDatabaseTypeResolver = (target: MultiDbExecutionTarget) => DatabaseType | undefined;

export function normalizeOptionalExecutionTargetPart(value?: string): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : undefined;
  return normalized ? normalized : undefined;
}

export function multiDbExecutionTargetKey(target: MultiDbExecutionTarget): string {
  return JSON.stringify([target.connectionId, normalizeOptionalExecutionTargetPart(target.catalog), target.database, normalizeOptionalExecutionTargetPart(target.schema)]);
}

export function normalizeMultiDbExecutionTarget(target: MultiDbExecutionTarget): MultiDbExecutionTarget | undefined {
  if (!target || typeof target !== "object") return undefined;
  const raw = target as Partial<MultiDbExecutionTarget>;
  const connectionId = typeof raw.connectionId === "string" ? raw.connectionId.trim() : "";
  const database = typeof raw.database === "string" ? raw.database.trim() : undefined;
  if (!connectionId || database === undefined) return undefined;
  return {
    connectionId,
    database,
    catalog: normalizeOptionalExecutionTargetPart(raw.catalog),
    schema: normalizeOptionalExecutionTargetPart(raw.schema),
  };
}

export function dedupeMultiDbExecutionTargets(targets: readonly MultiDbExecutionTarget[]): MultiDbExecutionTarget[] {
  const result: MultiDbExecutionTarget[] = [];
  const seen = new Set<string>();
  for (const candidate of targets) {
    const target = normalizeMultiDbExecutionTarget(candidate);
    if (!target) continue;
    const key = multiDbExecutionTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

export function executionTargetGroupNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}
