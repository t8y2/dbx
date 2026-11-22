import type { TreeNode } from "@/types/database";
import { quotePostgresIdentifier } from "@/lib/database/databaseUserAdmin";
import type { JdbcDialectConnection } from "@/lib/database/jdbcDialect";
import { mysqlObjectTemplateForGroup, type MysqlObjectTemplate } from "@/lib/sidebar/mysqlObjectTemplates";
import { firebirdObjectTemplateForGroup, type FirebirdObjectTemplate } from "@/lib/sidebar/firebirdObjectTemplates";

export type SidebarObjectTemplate = MysqlObjectTemplate | FirebirdObjectTemplate | { titleKey: "contextMenu.createSequence"; sql: string };

export function sidebarObjectTemplateForGroup(connection: JdbcDialectConnection | undefined, node: Pick<TreeNode, "type" | "database" | "tableName" | "schema">): SidebarObjectTemplate | null {
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
  return mysqlObjectTemplateForGroup(connection, node) || firebirdObjectTemplateForGroup(connection, node);
}
