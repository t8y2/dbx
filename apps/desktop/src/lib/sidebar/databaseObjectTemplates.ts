import type { TreeNode } from "@/types/database";
import type { JdbcDialectConnection } from "@/lib/database/jdbcDialect";
import { mysqlObjectTemplateForGroup, type MysqlObjectTemplate } from "@/lib/sidebar/mysqlObjectTemplates";
import { firebirdObjectTemplateForGroup, type FirebirdObjectTemplate } from "@/lib/sidebar/firebirdObjectTemplates";

export type SidebarObjectTemplate = MysqlObjectTemplate | FirebirdObjectTemplate;

export function sidebarObjectTemplateForGroup(connection: JdbcDialectConnection | undefined, node: Pick<TreeNode, "type" | "database" | "tableName">): SidebarObjectTemplate | null {
  return mysqlObjectTemplateForGroup(connection, node) || firebirdObjectTemplateForGroup(connection, node);
}
