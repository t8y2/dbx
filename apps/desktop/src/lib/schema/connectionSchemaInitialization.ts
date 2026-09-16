import type { DatabaseType } from "@/types/database";

export function schemaAfterConnectionSwitch(databaseType: DatabaseType | undefined, orderedSchemaNames: string[], configuredDefaultSchema?: string): string | undefined {
  if (configuredDefaultSchema?.trim()) return configuredDefaultSchema.trim();
  if (databaseType !== "oracle") return undefined;
  return orderedSchemaNames[0];
}
