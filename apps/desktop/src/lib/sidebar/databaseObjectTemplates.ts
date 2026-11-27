import type { ConnectionConfig, TreeNode } from "@/types/database";
import { quotePostgresIdentifier } from "@/lib/database/databaseUserAdmin";
import type { JdbcDialectConnection } from "@/lib/database/jdbcDialect";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { isSqlServerLinkedNode, quoteSqlServerIdentifier } from "@/lib/database/sqlServerLinkedServers";
import { mysqlObjectTemplateForGroup, type MysqlObjectTemplate } from "@/lib/sidebar/mysqlObjectTemplates";
import { firebirdObjectTemplateForGroup, type FirebirdObjectTemplate } from "@/lib/sidebar/firebirdObjectTemplates";

export type SidebarObjectTemplate = MysqlObjectTemplate | FirebirdObjectTemplate | { titleKey: "contextMenu.createSequence" | "contextMenu.createProcedure"; sql: string };

export function sidebarObjectTemplateForGroup(connection: (JdbcDialectConnection & Partial<Pick<ConnectionConfig, "id" | "read_only">>) | undefined, node: Pick<TreeNode, "type" | "database" | "tableName" | "schema" | "linkedServer" | "linkedCatalog" | "linkedSchema">): SidebarObjectTemplate | null {
  if (connection?.db_type === "postgres" && (node.type === "schema" || node.type === "group-sequences") && node.database && node.schema) {
    return {
      titleKey: "contextMenu.createSequence",
      sql: `CREATE SEQUENCE ${quotePostgresIdentifier(node.schema)}.new_sequence
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    START WITH 1
    CACHE 1
    NO CYCLE;`,
    };
  }
  if (connection?.db_type === "sqlserver" && node.type === "group-procedures" && node.database && !isSqlServerLinkedNode(node) && !connectionIsEffectivelyReadOnly(connection)) {
    const name = node.schema ? `${quoteSqlServerIdentifier(node.schema)}.[new_procedure]` : "[new_procedure]";
    return {
      titleKey: "contextMenu.createProcedure",
      sql: `CREATE PROCEDURE ${name}
AS
BEGIN
  SET NOCOUNT ON;
  SELECT 1;
END;`,
    };
  }
  return mysqlObjectTemplateForGroup(connection, node) || firebirdObjectTemplateForGroup(connection, node);
}
