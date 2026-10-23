import type { TreeNode } from "@/types/database";
import { effectiveDatabaseTypeForConnection, type JdbcDialectConnection } from "@/lib/database/jdbcDialect";

export type OracleObjectTemplateKind = "trigger";

export interface OracleObjectTemplate {
  kind: OracleObjectTemplateKind;
  titleKey: "contextMenu.createTrigger";
  sql: string;
}

type OracleTemplateNode = Pick<TreeNode, "type" | "database" | "schema">;

export function supportsOracleObjectTemplates(connection?: JdbcDialectConnection): boolean {
  return effectiveDatabaseTypeForConnection(connection) === "oracle";
}

export function oracleObjectTemplateForGroup(connection: JdbcDialectConnection | undefined, node: OracleTemplateNode): OracleObjectTemplate | null {
  if (!supportsOracleObjectTemplates(connection) || node.type !== "group-triggers" || !node.database) return null;
  return buildOracleObjectTemplate(node.schema || node.database);
}

export function buildOracleObjectTemplate(schema: string): OracleObjectTemplate {
  const owner = quoteOracleIdentifier(schema);
  return {
    kind: "trigger",
    titleKey: "contextMenu.createTrigger",
    sql: `CREATE OR REPLACE TRIGGER ${owner}."NEW_TRIGGER"
BEFORE INSERT ON ${owner}."TABLE_NAME"
FOR EACH ROW
BEGIN
  NULL;
END;
/`,
  };
}

function quoteOracleIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
