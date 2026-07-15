import type { ObjectSourceKind } from "@/types/database";

export function tableObjectSourceKind(tableType: string | null | undefined): ObjectSourceKind | undefined {
  const normalized = tableType
    ?.trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "VIEW") return "VIEW";
  if (normalized === "MATERIALIZED_VIEW") return "MATERIALIZED_VIEW";
  return undefined;
}
