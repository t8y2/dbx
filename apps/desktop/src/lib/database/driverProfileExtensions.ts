import { DOLT_DRIVER_PROFILE_EXTENSION } from "@/lib/database/doltProfile";
import type { SqlCompletionObject, SqlCompletionTable, SqlStatementKind } from "@/lib/sql/sqlCompletion";
import type { ConnectionConfig, QueryTab, TableNameFilter, TreeNodeType } from "@/types/database";

export type DriverProfileObjectTreeProfile = {
  cacheKey: string;
  groupOverrides: Array<{
    nodeType: TreeNodeType;
    label?: string;
    tableNameFilter: TableNameFilter;
  }>;
};

export type DriverProfileSqlCompletionContext = {
  statementKind: SqlStatementKind;
  suggestTables: boolean;
  suggestRoutines: boolean;
  exclusiveRoutineSuggestions: boolean;
  prefix: string;
  openingParenAfterCursor: boolean;
};

export type DriverProfileCompletionTableMetadata = Pick<SqlCompletionTable, "detail" | "boost">;

export type DriverProfileWorkspaceTarget = {
  database: string;
  branch?: string;
};

export type DriverProfileWorkspaceScope = "database" | "connection";

export type DriverProfileDatabaseWorkspace = {
  mode: QueryTab["mode"];
  menuLabelKey: string;
  tabTitleKey: string;
  /** Determines whether tabs are reused per connection or per database. */
  tabScope: DriverProfileWorkspaceScope;
  /** Tree levels whose context menu exposes the workspace entry. */
  entryScopes: readonly DriverProfileWorkspaceScope[];
  /** Maps a tree database name to the context opened by the workspace. */
  resolveTarget?: (database: string, source: DriverProfileWorkspaceScope) => DriverProfileWorkspaceTarget;
};

export type DriverProfileExtensionDefinition = {
  id: string;
  objectTreeProfile?: (config: ConnectionConfig) => DriverProfileObjectTreeProfile | undefined;
  completionTableMetadata?: (tableName: string) => DriverProfileCompletionTableMetadata | undefined;
  completionObjects?: (context: DriverProfileSqlCompletionContext) => SqlCompletionObject[];
  completionTables?: (context: DriverProfileSqlCompletionContext) => SqlCompletionTable[];
  sqlBuiltinTerms?: () => string;
  routineSignatures?: () => Map<string, string[]>;
  databaseWorkspace?: DriverProfileDatabaseWorkspace;
};

export const DRIVER_PROFILE_EXTENSIONS = [DOLT_DRIVER_PROFILE_EXTENSION] as const satisfies readonly DriverProfileExtensionDefinition[];

export function driverProfileExtension(driverProfile?: string): DriverProfileExtensionDefinition | undefined {
  const normalized = driverProfile?.trim().toLowerCase();
  if (!normalized) return undefined;
  return DRIVER_PROFILE_EXTENSIONS.find((extension) => extension.id.toLowerCase() === normalized);
}

export function driverProfileObjectTreeProfileForConnection(config?: ConnectionConfig): DriverProfileObjectTreeProfile | undefined {
  if (!config) return undefined;
  return driverProfileExtension(config.driver_profile)?.objectTreeProfile?.(config);
}

export function driverProfileCompletionTableMetadata(driverProfile: string | undefined, tableName: string): DriverProfileCompletionTableMetadata | undefined {
  return driverProfileExtension(driverProfile)?.completionTableMetadata?.(tableName);
}

export function driverProfileCompletionObjects(driverProfile: string | undefined, context: DriverProfileSqlCompletionContext): SqlCompletionObject[] {
  return driverProfileExtension(driverProfile)?.completionObjects?.(context) ?? [];
}

export function driverProfileCompletionTables(driverProfile: string | undefined, context: DriverProfileSqlCompletionContext): SqlCompletionTable[] {
  return driverProfileExtension(driverProfile)?.completionTables?.(context) ?? [];
}

export function driverProfileHasCompletionCandidates(driverProfile: string | undefined, context: DriverProfileSqlCompletionContext): boolean {
  const extension = driverProfileExtension(driverProfile);
  return Boolean(extension?.completionObjects?.(context).length || extension?.completionTables?.(context).length);
}

export function driverProfileSqlBuiltinTerms(driverProfile?: string): string {
  return driverProfileExtension(driverProfile)?.sqlBuiltinTerms?.() ?? "";
}

export function driverProfileRoutineSignatures(driverProfile?: string): Map<string, string[]> {
  return driverProfileExtension(driverProfile)?.routineSignatures?.() ?? new Map();
}

export function driverProfileDatabaseWorkspace(driverProfile?: string): DriverProfileDatabaseWorkspace | undefined {
  return driverProfileExtension(driverProfile)?.databaseWorkspace;
}
