import type { TreeNodeType } from "@/types/database";
import type { DatabaseDependencyProvider, DependencyTreeNode } from "@/lib/database/databaseObjectDependencies";

export type XuguDependencyObjectType = "table" | "view" | "procedure" | "function" | "trigger" | "package";

const OBJECT_TYPE_CODES: Record<XuguDependencyObjectType, number> = {
  table: 5,
  procedure: 7,
  function: 7,
  view: 9,
  trigger: 11,
  package: 18,
};

/**
 * Returns the XuguDB dictionary object kind supported by the dependency
 * inspector. Package members and package bodies intentionally return null:
 * ALL_DEPENDS records dependencies for their owning schema object instead.
 */
export function xuguDependencyObjectTypeForTreeNode(type: TreeNodeType): XuguDependencyObjectType | null {
  switch (type) {
    case "table":
    case "view":
    case "procedure":
    case "function":
    case "trigger":
    case "package":
      return type;
    default:
      return null;
  }
}

/**
 * Builds a read-only query over XuguDB's accessible dependency dictionary.
 *
 * ALL_* views deliberately preserve the server's permission boundary: a
 * regular user sees only dependencies of objects it is allowed to inspect,
 * while administrative connections can see the broader catalog. Both
 * directions are returned so callers can assess an object's prerequisites and
 * the impact of changing it.
 */
export function xuguObjectDependenciesSql(options: { schema: string; objectName: string; objectType: XuguDependencyObjectType }): string {
  const schema = quoteXuguString(options.schema);
  const objectName = quoteXuguString(options.objectName);
  const objectType = OBJECT_TYPE_CODES[options.objectType];
  return `WITH target AS (
  SELECT o.DB_ID, o.SCHEMA_ID, o.OBJ_ID, o.OBJ_TYPE
  FROM ALL_OBJECTS o
  JOIN ALL_SCHEMAS s ON s.DB_ID = o.DB_ID AND s.SCHEMA_ID = o.SCHEMA_ID
  WHERE o.DB_ID = CURRENT_DB_ID
    AND UPPER(s.SCHEMA_NAME) = UPPER(${schema})
    AND UPPER(o.OBJ_NAME) = UPPER(${objectName})
    AND o.OBJ_TYPE = ${objectType}
), dependency_rows AS (
  SELECT 'DEPENDS_ON' AS DIRECTION, d.OWNER_ID1 AS OWNER_ID, d.OBJ_ID1 AS OBJ_ID, d.OBJ_TYPE1 AS OBJ_TYPE, d.DB_ID
  FROM target t
  JOIN ALL_DEPENDS d ON d.DB_ID = t.DB_ID AND d.OWNER_ID2 = t.SCHEMA_ID AND d.OBJ_ID2 = t.OBJ_ID AND d.OBJ_TYPE2 = t.OBJ_TYPE
  UNION ALL
  SELECT 'REFERENCED_BY' AS DIRECTION, d.OWNER_ID2 AS OWNER_ID, d.OBJ_ID2 AS OBJ_ID, d.OBJ_TYPE2 AS OBJ_TYPE, d.DB_ID
  FROM target t
  JOIN ALL_DEPENDS d ON d.DB_ID = t.DB_ID AND d.OWNER_ID1 = t.SCHEMA_ID AND d.OBJ_ID1 = t.OBJ_ID AND d.OBJ_TYPE1 = t.OBJ_TYPE
)
SELECT r.DIRECTION,
       s.SCHEMA_NAME,
       o.OBJ_NAME AS OBJECT_NAME,
       CASE o.OBJ_TYPE
         WHEN 5 THEN 'TABLE'
         WHEN 7 THEN 'PROCEDURE_OR_FUNCTION'
         WHEN 9 THEN 'VIEW'
         WHEN 11 THEN 'TRIGGER'
         WHEN 18 THEN 'PACKAGE'
         ELSE 'OBJECT_' || o.OBJ_TYPE
       END AS OBJECT_TYPE
FROM dependency_rows r
JOIN ALL_OBJECTS o ON o.DB_ID = r.DB_ID AND o.SCHEMA_ID = r.OWNER_ID AND o.OBJ_ID = r.OBJ_ID AND o.OBJ_TYPE = r.OBJ_TYPE
JOIN ALL_SCHEMAS s ON s.DB_ID = o.DB_ID AND s.SCHEMA_ID = o.SCHEMA_ID
ORDER BY r.DIRECTION, s.SCHEMA_NAME, o.OBJ_NAME;`;
}

/** XuguDB implementation of the shared dependency-inspection contract. */
export const xuguDependencyProvider: DatabaseDependencyProvider = {
  databaseType: "xugu",
  supports(node: DependencyTreeNode): boolean {
    // Package members and package bodies do not have independent ALL_DEPENDS
    // records in XuguDB; exposing the action for them would be misleading.
    if (node.parentType === "package" || node.type === "package-body") return false;
    return xuguDependencyObjectTypeForTreeNode(node.type) !== null;
  },
  buildQuery(node: DependencyTreeNode): string | null {
    const objectType = xuguDependencyObjectTypeForTreeNode(node.type);
    const objectName = node.objectName || node.label;
    if (!objectType || !node.schema || !objectName) return null;
    return xuguObjectDependenciesSql({ schema: node.schema, objectName, objectType });
  },
};

function quoteXuguString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
