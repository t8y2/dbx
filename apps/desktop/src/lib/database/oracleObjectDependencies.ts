import type { TreeNodeType } from "@/types/database";
import type { DatabaseDependencyProvider, DependencyTreeNode } from "@/lib/database/databaseObjectDependencies";

export type OracleDependencyObjectType = "PROCEDURE" | "FUNCTION" | "PACKAGE";

/** Direct Oracle dictionary dependency rows, visible to the current account. */
export function oracleObjectDependenciesSql(options: { schema: string; objectName: string; objectType: OracleDependencyObjectType }): string {
  const owner = quoteSqlString(options.schema);
  const name = quoteSqlString(options.objectName);
  const typeFilter = options.objectType === "PACKAGE" ? "d.TYPE IN ('PACKAGE', 'PACKAGE BODY')" : `d.TYPE = '${options.objectType}'`;
  const referenceTypeFilter = options.objectType === "PACKAGE" ? "d.REFERENCED_TYPE IN ('PACKAGE', 'PACKAGE BODY')" : `d.REFERENCED_TYPE = '${options.objectType}'`;
  const scopeNote = options.objectType === "PACKAGE" ? " Package/body scope, not member-level dependencies." : "";
  return `-- Direct dependencies and reverse references visible to the current account via ALL_DEPENDENCIES. Dynamic SQL references may be absent.${scopeNote}
SELECT 'DEPENDS_ON' AS DIRECTION,
       ${owner} AS TARGET_OWNER,
       ${name} AS TARGET_NAME,
       '${options.objectType}' AS TARGET_TYPE,
       d.OWNER AS OBJECT_OWNER,
       d.NAME AS OBJECT_NAME,
       d.TYPE AS OBJECT_TYPE,
       d.REFERENCED_OWNER,
       d.REFERENCED_NAME,
       d.REFERENCED_TYPE,
       d.DEPENDENCY_TYPE,
       d.REFERENCED_LINK_NAME
FROM ALL_DEPENDENCIES d
WHERE d.OWNER = ${owner}
  AND d.NAME = ${name}
  AND ${typeFilter}
UNION ALL
SELECT 'REFERENCED_BY' AS DIRECTION,
       ${owner} AS TARGET_OWNER,
       ${name} AS TARGET_NAME,
       '${options.objectType}' AS TARGET_TYPE,
       d.OWNER AS OBJECT_OWNER,
       d.NAME AS OBJECT_NAME,
       d.TYPE AS OBJECT_TYPE,
       d.REFERENCED_OWNER,
       d.REFERENCED_NAME,
       d.REFERENCED_TYPE,
       d.DEPENDENCY_TYPE,
       d.REFERENCED_LINK_NAME
FROM ALL_DEPENDENCIES d
WHERE d.REFERENCED_OWNER = ${owner}
  AND d.REFERENCED_NAME = ${name}
  AND ${referenceTypeFilter}
  AND d.REFERENCED_LINK_NAME IS NULL
ORDER BY 1, 5, 6, 7`;
}

export function oracleTarget(node: DependencyTreeNode): { schema: string; name: string; type: OracleDependencyObjectType; packaged: boolean } | null {
  const member = node.parentType === "package" && (node.type === "procedure" || node.type === "function");
  const type = member || node.type === "package" ? "PACKAGE" : oracleTypeForTreeNode(node.type);
  const schema = member ? node.parentSchema : node.schema;
  const name = member ? node.parentName : node.objectName || node.label;
  if (!schema || !name || !type) return null;
  return { schema, name, type, packaged: member || type === "PACKAGE" };
}

function oracleTypeForTreeNode(type: TreeNodeType): OracleDependencyObjectType | null {
  if (type === "procedure") return "PROCEDURE";
  if (type === "function") return "FUNCTION";
  if (type === "package") return "PACKAGE";
  return null;
}

export const oracleDependencyProvider: DatabaseDependencyProvider = {
  databaseType: "oracle",
  supports(node) {
    return oracleTarget(node) !== null;
  },
  buildQuery(node) {
    const target = oracleTarget(node);
    return target ? oracleObjectDependenciesSql({ schema: target.schema, objectName: target.name, objectType: target.type }) : null;
  },
  targetLabel(node) {
    const target = oracleTarget(node);
    return target ? { name: `${target.schema}.${target.name}`, packageScope: target.packaged } : null;
  },
};

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
