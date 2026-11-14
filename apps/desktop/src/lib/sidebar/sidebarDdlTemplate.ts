import { joinExportedDdls } from "@/lib/export/ddlExport";
import { applyDdlDatabaseQualifier, omitDdlIdentifierQuotes } from "@/lib/sql/ddlDisplay";
import { applyDdlTextPreferences } from "@/lib/sql/ddlPreferences";
import type { SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import type { DatabaseType } from "@/types/database";

interface SidebarDdlExecutionTarget {
  connectionId: string;
  database: string;
  catalog?: string;
}

export function sidebarDdlTargetsForExecutionContext<T extends SidebarDdlExecutionTarget>(activeTarget: SidebarDdlExecutionTarget, targets: readonly T[]): T[] {
  return targets.filter((target) => target.connectionId === activeTarget.connectionId && target.database === activeTarget.database && (target.catalog ?? "") === (activeTarget.catalog ?? ""));
}

export async function buildSidebarDdlTemplateSql<T>(targets: readonly T[], loadDdl: (target: T) => Promise<string>, formatDdl: (ddl: string, target: T) => Promise<string>): Promise<string> {
  const parts: string[] = [];
  for (const target of targets) {
    parts.push(await formatDdl(await loadDdl(target), target));
  }
  return parts.length === 1 ? parts[0]! : joinExportedDdls(parts);
}

// Text preferences run last, in the same order as the DDL viewers, so "Generate SQL > DDL" matches "View DDL".
export function formatSidebarDdlTemplateForDisplay(
  sql: string,
  dialect: SqlFormatDialect,
  databaseType: DatabaseType | undefined,
  includeDatabaseName: boolean,
  database: string | undefined,
  quoteIdentifiers: boolean,
  textPreferences: { includeDdlStorage: boolean; compactDdlSql: boolean },
  catalog?: string,
): string {
  const unqualified = applyDdlDatabaseQualifier(sql, dialect, databaseType, includeDatabaseName, database, catalog);
  return applyDdlTextPreferences(quoteIdentifiers ? unqualified : omitDdlIdentifierQuotes(unqualified, dialect), databaseType, textPreferences);
}
