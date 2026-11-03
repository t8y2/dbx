import type { TreeNodeType } from "@/types/database";
import type { DatabaseDependencyProvider, DependencyTreeNode } from "@/lib/database/databaseObjectDependencies";
import { exactOracleTriggerNodeMetadata } from "@/lib/database/oracleTriggerIdentity";

export type OracleDependencyObjectType = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "PACKAGE" | "TYPE" | "TYPE_BODY" | "SEQUENCE" | "SYNONYM" | "TRIGGER" | "INDEX";
export type ObjectRelationKind = "dependencies" | "foreignKeys" | "ownership";

const dictionaryType = (type: OracleDependencyObjectType) => type.replaceAll("_", " ");

/** Direct Oracle dictionary dependency rows, visible to the current account. */
export function oracleObjectDependenciesSql(options: { schema: string; objectName: string; objectType: OracleDependencyObjectType }): string {
  const owner = quoteSqlString(options.schema);
  const name = quoteSqlString(options.objectName);
  const typeFilter = options.objectType === "PACKAGE" ? "d.TYPE IN ('PACKAGE', 'PACKAGE BODY')" : `d.TYPE = '${dictionaryType(options.objectType)}'`;
  const referenceTypeFilter = options.objectType === "PACKAGE" ? "d.REFERENCED_TYPE IN ('PACKAGE', 'PACKAGE BODY')" : `d.REFERENCED_TYPE = '${dictionaryType(options.objectType)}'`;
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
  if (node.type === "trigger") {
    const metadata = exactOracleTriggerNodeMetadata(node);
    return metadata ? { schema: metadata.owner, name: metadata.name, type: "TRIGGER", packaged: false } : null;
  }
  const member = node.parentType === "package" && (node.type === "procedure" || node.type === "function");
  const type = member || node.type === "package" ? "PACKAGE" : oracleTypeForTreeNode(node.type);
  const schema = member ? node.parentSchema : node.schema;
  const name = member ? node.parentName : node.objectName || node.label;
  if (!schema || !name || !type) return null;
  return { schema, name, type, packaged: member || type === "PACKAGE" };
}

function oracleTypeForTreeNode(type: TreeNodeType): OracleDependencyObjectType | null {
  const types: Partial<Record<TreeNodeType, OracleDependencyObjectType>> = {
    table: "TABLE",
    view: "VIEW",
    materialized_view: "MATERIALIZED_VIEW",
    procedure: "PROCEDURE",
    function: "FUNCTION",
    package: "PACKAGE",
    "package-body": "PACKAGE",
    type: "TYPE",
    "type-body": "TYPE_BODY",
    sequence: "SEQUENCE",
    synonym: "SYNONYM",
    trigger: "TRIGGER",
    index: "INDEX",
  };
  return types[type] ?? null;
}

export function oracleObjectRelationKinds(type: OracleDependencyObjectType): ObjectRelationKind[] {
  return ["dependencies", ...(type === "TABLE" ? ["foreignKeys" as const] : []), ...(["TABLE", "VIEW", "MATERIALIZED_VIEW", "TRIGGER", "INDEX"].includes(type) ? ["ownership" as const] : [])];
}

export function oracleObjectRelationsSql(target: { schema: string; objectName: string; objectType: OracleDependencyObjectType }, kind: ObjectRelationKind): string {
  if (kind === "dependencies") return oracleObjectDependenciesSql(target);
  if (!oracleObjectRelationKinds(target.objectType).includes(kind)) throw new Error("This relation kind is not supported for this object.");
  const owner = quoteSqlString(target.schema),
    name = quoteSqlString(target.objectName);
  if (kind === "foreignKeys") {
    const select = (direction: string, filter: string) => `SELECT '${direction}' AS DIRECTION,
       f.OWNER AS CONSTRAINT_OWNER, f.CONSTRAINT_NAME,
       f.OWNER AS CHILD_OWNER, f.TABLE_NAME AS CHILD_NAME,
       cc.COLUMN_NAME AS CHILD_COLUMN, cc.POSITION,
       f.R_OWNER AS PARENT_OWNER, p.TABLE_NAME AS PARENT_NAME, pc.COLUMN_NAME AS PARENT_COLUMN,
       (SELECT COUNT(*) FROM ALL_CONS_COLUMNS cols WHERE cols.OWNER = f.OWNER AND cols.CONSTRAINT_NAME = f.CONSTRAINT_NAME) AS COLUMN_COUNT
FROM ALL_CONSTRAINTS f
LEFT JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = f.OWNER AND cc.CONSTRAINT_NAME = f.CONSTRAINT_NAME
LEFT JOIN ALL_CONSTRAINTS p ON p.OWNER = f.R_OWNER AND p.CONSTRAINT_NAME = f.R_CONSTRAINT_NAME AND p.CONSTRAINT_TYPE IN ('P', 'U')
LEFT JOIN ALL_CONS_COLUMNS pc ON pc.OWNER = p.OWNER AND pc.CONSTRAINT_NAME = p.CONSTRAINT_NAME AND pc.POSITION = cc.POSITION
WHERE f.CONSTRAINT_TYPE = 'R' AND ${filter}`;
    return `${select("REFERENCES", `f.OWNER = ${owner} AND f.TABLE_NAME = ${name}`)}
UNION ALL
${select("REFERENCED_BY", `p.OWNER = ${owner} AND p.TABLE_NAME = ${name}`)}
ORDER BY 1, 2, 3, 7`;
  }
  const child = target.objectType === "INDEX" || target.objectType === "TRIGGER";
  const queries: string[] = [];
  if (target.objectType !== "TRIGGER")
    queries.push(`SELECT i.OWNER AS CHILD_OWNER, i.INDEX_NAME AS CHILD_NAME, 'INDEX' AS CHILD_TYPE,
       i.TABLE_OWNER AS PARENT_OWNER, i.TABLE_NAME AS PARENT_NAME,
       CASE WHEN EXISTS (SELECT 1 FROM ALL_OBJECTS o WHERE o.OWNER = i.TABLE_OWNER AND o.OBJECT_NAME = i.TABLE_NAME AND o.OBJECT_TYPE = 'MATERIALIZED VIEW') THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS PARENT_TYPE
FROM ALL_INDEXES i WHERE ${child ? `i.OWNER = ${owner} AND i.INDEX_NAME = ${name}` : `i.TABLE_OWNER = ${owner} AND i.TABLE_NAME = ${name}`}`);
  if (target.objectType !== "INDEX")
    queries.push(`SELECT t.OWNER AS CHILD_OWNER, t.TRIGGER_NAME AS CHILD_NAME, 'TRIGGER' AS CHILD_TYPE,
       t.TABLE_OWNER AS PARENT_OWNER, t.TABLE_NAME AS PARENT_NAME,
       CASE WHEN EXISTS (SELECT 1 FROM ALL_OBJECTS o WHERE o.OWNER = t.TABLE_OWNER AND o.OBJECT_NAME = t.TABLE_NAME AND o.OBJECT_TYPE = 'MATERIALIZED VIEW') THEN 'MATERIALIZED VIEW' ELSE t.BASE_OBJECT_TYPE END AS PARENT_TYPE
FROM ALL_TRIGGERS t WHERE ${child ? `t.OWNER = ${owner} AND t.TRIGGER_NAME = ${name}` : `t.TABLE_OWNER = ${owner} AND t.TABLE_NAME = ${name}`}`);
  return `${queries.join("\nUNION ALL\n")}\nORDER BY 1, 2, 3`;
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

export const dmTriggerDependencyProvider: DatabaseDependencyProvider = {
  databaseType: "dameng",
  supports(node) {
    const metadata = exactOracleTriggerNodeMetadata(node);
    return metadata?.engine === "dm" && /(?:^|\D)8\./.test(metadata.engineVersion ?? "");
  },
  buildQuery(node) {
    return dmTriggerDependencyProvider.supports(node) ? oracleDependencyProvider.buildQuery(node) : null;
  },
  targetLabel(node) {
    return dmTriggerDependencyProvider.supports(node) ? oracleDependencyProvider.targetLabel!(node) : null;
  },
};

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
