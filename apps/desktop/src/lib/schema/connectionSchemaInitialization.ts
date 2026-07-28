import type { DatabaseType } from "@/types/database";

export function schemaAfterConnectionSwitch(databaseType: DatabaseType | undefined, orderedSchemaNames: string[]): string | undefined {
  if (databaseType !== "oracle") return undefined;
  return orderedSchemaNames[0];
}
