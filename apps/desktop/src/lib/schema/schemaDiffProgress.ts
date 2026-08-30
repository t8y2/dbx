import type { SchemaDiffCompareOptions } from "@/types/schemaDiff";

export type SchemaDiffProgressPhase = "loading-table-lists" | "loading-source-details" | "loading-target-details" | "loading-extra-objects" | "comparing" | "generating" | "complete";

export type SchemaDiffNextProgressStep = "nextSourceDetails" | "nextTargetDetails" | "nextExtraObjects" | "nextComparing" | "nextGenerating" | "nextComplete";

export function isSchemaDiffPostgresLike(dbType: string | null | undefined): boolean {
  const normalizedDbType = (dbType || "").toLowerCase();
  return normalizedDbType === "postgres" || normalizedDbType === "opengauss";
}

export function shouldLoadSchemaDiffExtraObjects(dbType: string | null | undefined, options: Pick<SchemaDiffCompareOptions, "functions" | "sequences" | "rules" | "owners">): boolean {
  return isSchemaDiffPostgresLike(dbType) && (options.functions || options.sequences || options.rules || options.owners);
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
