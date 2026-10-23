import type { TreeNode } from "@/types/database";
import type { JdbcDialectConnection } from "@/lib/database/jdbcDialect";
import { mysqlObjectTemplateForGroup, type MysqlObjectTemplate } from "@/lib/sidebar/mysqlObjectTemplates";
import { firebirdObjectTemplateForGroup, type FirebirdObjectTemplate } from "@/lib/sidebar/firebirdObjectTemplates";
import { oracleObjectTemplateForGroup, type OracleObjectTemplate } from "@/lib/sidebar/oracleObjectTemplates";

export type SidebarObjectTemplate = MysqlObjectTemplate | FirebirdObjectTemplate | OracleObjectTemplate;

export function sidebarObjectTemplateForGroup(connection: JdbcDialectConnection | undefined, node: Pick<TreeNode, "type" | "database" | "tableName" | "schema">): SidebarObjectTemplate | null {
  return mysqlObjectTemplateForGroup(connection, node) || firebirdObjectTemplateForGroup(connection, node) || oracleObjectTemplateForGroup(connection, node);
}
