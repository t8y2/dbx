import type { SchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { DatabaseType } from "@/types/database";
import { schemaDiffRoutineObjectTypesIntersection } from "@/lib/database/databaseObjectCapabilities";

export type SchemaDiffProgressPhase = "loading-table-lists" | "loading-source-details" | "loading-target-details" | "loading-extra-objects" | "comparing" | "generating" | "complete";

export type SchemaDiffNextProgressStep = "nextSourceDetails" | "nextTargetDetails" | "nextExtraObjects" | "nextComparing" | "nextGenerating" | "nextComplete";

export function isSchemaDiffPostgresLike(dbType: string | null | undefined): boolean {
  const normalizedDbType = (dbType || "").toLowerCase();
  return normalizedDbType === "postgres" || normalizedDbType === "opengauss";
}

/** Extra objects that remain Postgres-catalog specific (sequences/rules/owners + PG function fast path). Routine compare for other DBs is gated separately via supportsSchemaDiffRoutines. */
export function shouldLoadSchemaDiffExtraObjects(dbType: string | null | undefined, options: Pick<SchemaDiffCompareOptions, "functions" | "sequences" | "rules" | "owners">): boolean {
  return isSchemaDiffPostgresLike(dbType) && (options.functions || options.sequences || options.rules || options.owners);
}

/** True when session will load routines via listFunctions for a supported source/target pair. */
export function shouldLoadSchemaDiffRoutines(sourceDbType: string | null | undefined, targetDbType: string | null | undefined, options: Pick<SchemaDiffCompareOptions, "functions">): boolean {
  if (!options.functions) return false;
  return schemaDiffRoutineObjectTypesIntersection(sourceDbType as DatabaseType | undefined, targetDbType as DatabaseType | undefined).length > 0;
}

/** Unified extra-object progress phase used by session + dialog next-step hints. */
export function shouldLoadSchemaDiffExtraObjectPhase(sourceDbType: string | null | undefined, targetDbType: string | null | undefined, options: Pick<SchemaDiffCompareOptions, "functions" | "sequences" | "rules" | "owners">): boolean {
  return shouldLoadSchemaDiffExtraObjects(targetDbType, options) || shouldLoadSchemaDiffRoutines(sourceDbType, targetDbType, options);
}

export function getSchemaDiffNextProgressStep(phase: SchemaDiffProgressPhase | undefined, hasExtraObjectPhase: boolean): SchemaDiffNextProgressStep | null {
  switch (phase) {
    case "loading-table-lists":
      return "nextSourceDetails";
    case "loading-source-details":
      return "nextTargetDetails";
    case "loading-target-details":
      return hasExtraObjectPhase ? "nextExtraObjects" : "nextComparing";
    case "loading-extra-objects":
      return "nextComparing";
    case "comparing":
      return "nextGenerating";
    case "generating":
      return "nextComplete";
    default:
      return null;
  }
}
