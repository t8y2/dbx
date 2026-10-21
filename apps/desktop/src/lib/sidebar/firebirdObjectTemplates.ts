import type { TreeNode, TreeNodeType } from "@/types/database";
import { effectiveDatabaseTypeForConnection, type JdbcDialectConnection } from "@/lib/database/jdbcDialect";

export type FirebirdObjectTemplateKind = "procedure" | "function" | "trigger";

export interface FirebirdObjectTemplate {
  kind: FirebirdObjectTemplateKind;
  titleKey: "contextMenu.createProcedure" | "contextMenu.createFunction" | "contextMenu.createTrigger";
  sql: string;
}

type FirebirdTemplateConnection = JdbcDialectConnection;
type FirebirdTemplateNode = Pick<TreeNode, "type" | "database" | "tableName">;

const templateKindByGroup: Partial<Record<TreeNodeType, FirebirdObjectTemplateKind>> = {
  "group-procedures": "procedure",
  "group-functions": "function",
  "group-triggers": "trigger",
};

export function supportsFirebirdObjectTemplates(connection?: FirebirdTemplateConnection): boolean {
  return effectiveDatabaseTypeForConnection(connection) === "firebird";
}

export function firebirdObjectTemplateForGroup(connection: FirebirdTemplateConnection | undefined, node: FirebirdTemplateNode): FirebirdObjectTemplate | null {
  if (!supportsFirebirdObjectTemplates(connection) || !node.database) return null;
  const kind = templateKindByGroup[node.type];
  if (!kind) return null;
  return buildFirebirdObjectTemplate(kind, node.tableName);
}

export function buildFirebirdObjectTemplate(kind: FirebirdObjectTemplateKind, tableName?: string): FirebirdObjectTemplate {
  if (kind === "procedure") {
    const name = "new_procedure";
    return {
      kind,
      titleKey: "contextMenu.createProcedure",
      sql: `CREATE OR ALTER PROCEDURE ${quoteFirebirdIdentifier(name)}
AS
BEGIN
  /* Procedure body */
END;`,
    };
  }

  if (kind === "function") {
    const name = "new_function";
    return {
      kind,
      titleKey: "contextMenu.createFunction",
      sql: `CREATE OR ALTER FUNCTION ${quoteFirebirdIdentifier(name)}()
RETURNS INTEGER
AS
BEGIN
  RETURN 0;
END;`,
    };
  }

  const name = "new_trigger";
  if (tableName) {
    return {
      kind,
      titleKey: "contextMenu.createTrigger",
      sql: `CREATE OR ALTER TRIGGER ${quoteFirebirdIdentifier(name)} FOR ${quoteFirebirdIdentifier(tableName)}
ACTIVE BEFORE INSERT POSITION 0
AS
BEGIN
  /* Trigger body */
END;`,
    };
  }

  return {
    kind,
    titleKey: "contextMenu.createTrigger",
    sql: `CREATE OR ALTER TRIGGER ${quoteFirebirdIdentifier(name)}
ACTIVE ON CONNECT POSITION 0
AS
BEGIN
  /* Trigger body */
END;`,
  };
}

export function quoteFirebirdIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
