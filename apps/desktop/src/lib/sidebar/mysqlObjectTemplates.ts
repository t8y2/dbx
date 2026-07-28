import type { ConnectionConfig, TreeNode, TreeNodeType } from "@/types/database";

export type MysqlObjectTemplateKind = "procedure" | "function" | "trigger";

export interface MysqlObjectTemplate {
  kind: MysqlObjectTemplateKind;
  titleKey: "contextMenu.createProcedure" | "contextMenu.createFunction" | "contextMenu.createTrigger";
  sql: string;
}

type MysqlTemplateConnection = Pick<ConnectionConfig, "db_type" | "driver_profile">;
type MysqlTemplateNode = Pick<TreeNode, "type" | "database" | "tableName">;

const templateKindByGroup: Partial<Record<TreeNodeType, MysqlObjectTemplateKind>> = {
  "group-procedures": "procedure",
  "group-functions": "function",
  "group-triggers": "trigger",
};

export function supportsMysqlObjectTemplates(connection?: MysqlTemplateConnection): boolean {
  if (connection?.db_type !== "mysql") return false;
  const profile = connection.driver_profile?.trim().toLowerCase();
  return !profile || profile === "mysql" || profile === "custom_mysql";
}

export function mysqlObjectTemplateForGroup(connection: MysqlTemplateConnection | undefined, node: MysqlTemplateNode): MysqlObjectTemplate | null {
  if (!supportsMysqlObjectTemplates(connection) || !node.database) return null;
  const kind = templateKindByGroup[node.type];
  if (!kind) return null;
  return buildMysqlObjectTemplate(kind, node.database, node.tableName);
}

export function buildMysqlObjectTemplate(kind: MysqlObjectTemplateKind, database: string, tableName?: string): MysqlObjectTemplate {
  const qualifiedDatabase = quoteMysqlIdentifier(database);

  if (kind === "procedure") {
    const name = "new_procedure";
    return {
      kind,
      titleKey: "contextMenu.createProcedure",
      sql: `DELIMITER $$

CREATE PROCEDURE ${qualifiedDatabase}.${quoteMysqlIdentifier(name)}()
BEGIN
  SELECT 1;
END$$

DELIMITER ;`,
    };
  }

  if (kind === "function") {
    const name = "new_function";
    return {
      kind,
      titleKey: "contextMenu.createFunction",
      sql: `DELIMITER $$

CREATE FUNCTION ${qualifiedDatabase}.${quoteMysqlIdentifier(name)}()
RETURNS INT
DETERMINISTIC
BEGIN
  RETURN 0;
END$$

DELIMITER ;`,
    };
  }

  const name = "new_trigger";
  return {
    kind,
    titleKey: "contextMenu.createTrigger",
    sql: `DELIMITER $$

CREATE TRIGGER ${qualifiedDatabase}.${quoteMysqlIdentifier(name)}
BEFORE INSERT ON ${qualifiedDatabase}.${quoteMysqlIdentifier(tableName || "table_name")}
FOR EACH ROW
BEGIN
  SET @dbx_trigger_placeholder = 1;
END$$

DELIMITER ;`,
  };
}

function quoteMysqlIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}
