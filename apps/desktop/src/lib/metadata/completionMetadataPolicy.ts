import type { DatabaseType } from "@/types/database";

const LOCAL_ONLY_EDITOR_COMPLETION_METADATA_TYPES = new Set<DatabaseType>(["prestosql", "trino"]);

export function usesLocalOnlyEditorCompletionMetadata(databaseType?: DatabaseType): boolean {
  return !!databaseType && LOCAL_ONLY_EDITOR_COMPLETION_METADATA_TYPES.has(databaseType);
}

export function usesOnDemandOnlyEditorColumnMetadata(databaseType?: DatabaseType): boolean {
  return !!databaseType && LOCAL_ONLY_EDITOR_COMPLETION_METADATA_TYPES.has(databaseType);
}
