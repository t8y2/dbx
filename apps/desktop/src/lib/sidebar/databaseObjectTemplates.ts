import type { TreeNode } from "@/types/database";
import type { JdbcDialectConnection } from "@/lib/database/jdbcDialect";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { qualifiedTableName } from "@/lib/table/tableSelectSql";
import { mysqlObjectTemplateForGroup, type MysqlObjectTemplate } from "@/lib/sidebar/mysqlObjectTemplates";
import { firebirdObjectTemplateForGroup, type FirebirdObjectTemplate } from "@/lib/sidebar/firebirdObjectTemplates";

export type SidebarObjectTemplate = MysqlObjectTemplate | FirebirdObjectTemplate;

export function sidebarObjectTemplateForGroup(connection: JdbcDialectConnection | undefined, node: Pick<TreeNode, "type" | "database" | "tableName">): SidebarObjectTemplate | null {
  return mysqlObjectTemplateForGroup(connection, node) || firebirdObjectTemplateForGroup(connection, node);
}

export function sidebarViewTemplateSql(connection: JdbcDialectConnection | undefined, node: Pick<TreeNode, "schema">, options: { identifierQuote?: string; includeDatabaseName: boolean; quoteIdentifiers: boolean }): string {
  const databaseType = effectiveDatabaseTypeForConnection(connection);
  const name = databaseType === "informix" || !node.schema ? "new_view" : qualifiedTableName({ databaseType, schema: node.schema, tableName: "new_view", ...options });
  return `CREATE VIEW ${name} AS\nSELECT\n  *\nFROM table_name;\n`;
}
