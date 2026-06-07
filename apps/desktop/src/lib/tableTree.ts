import type { ObjectInfo, TableInfo, TreeNode, TreeNodeType } from "@/types/database";

const databaseObjectNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function normalizeDatabaseObjectName(name: string): string {
  return name.trim();
}

export function buildTableTreeNodes({
  nodeId,
  connectionId,
  database,
  schema,
  tables,
}: {
  nodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  tables: TableInfo[];
}): TreeNode[] {
  const entries = tables.flatMap((table) => {
    const name = normalizeDatabaseObjectName(table.name);
    if (!name) return [];
    const objectType = normalizeObjectType(table.table_type);
    const childSchema = schema;
    return [
      makeTableTreeEntry({
        nodeId,
        connectionId,
        database,
        schema: childSchema,
        includeSchemaInId: false,
        name,
        objectType,
        comment: table.comment,
        parentSchema: table.parent_schema,
        parentName: table.parent_name,
      }),
    ];
  });

  return buildPartitionTree(entries, connectionId, database);
}

type TableTreeEntry = {
  key: string;
  objectType: DatabaseObjectTreeKind;
  schema?: string;
  parentSchema?: string;
  parentName?: string;
  node: TreeNode;
};

function makeTableTreeEntry({
  nodeId,
  connectionId,
  database,
  schema,
  includeSchemaInId,
  name,
  objectType,
  comment,
  parentSchema,
  parentName,
}: {
  nodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  includeSchemaInId?: boolean;
  name: string;
  objectType: DatabaseObjectTreeKind;
  comment?: string | null;
  parentSchema?: string | null;
  parentName?: string | null;
}): TableTreeEntry {
  const normalizedParentSchema = parentSchema ? normalizeDatabaseObjectName(parentSchema) : undefined;
  const normalizedParentName = parentName ? normalizeDatabaseObjectName(parentName) : undefined;
  const nodeIdSchemaSuffix = includeSchemaInId !== false && schema ? `${schema}:` : "";
  const node: TreeNode = {
    id: `${nodeId}:${nodeIdSchemaSuffix}${name}`,
    label: name,
    type: objectType === "VIEW" ? ("view" as const) : ("table" as const),
    comment,
    connectionId,
    database,
    schema,
    isExpanded: false,
    children: [],
  };

  return {
    key: objectIdentityKey(objectType, schema, name),
    objectType,
    schema,
    parentSchema: normalizedParentSchema,
    parentName: normalizedParentName,
    node,
  };
}

function objectIdentityKey(objectType: string, schema: string | undefined, name: string) {
  return `${objectType}\0${(schema || "").toLowerCase()}\0${name.toLowerCase()}`;
}

type PrefixSortInfo = {
  rootName: string;
  leadingSegments: number;
};

function nameSegments(name: string): string[] {
  return name.toLowerCase().split("_").filter(Boolean);
}

function findSubsequence(haystack: readonly string[], needle: readonly string[]): number {
  if (!needle.length || needle.length > haystack.length) return -1;

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }

  return -1;
}

function buildPrefixSortIndex(names: readonly string[]): Map<string, PrefixSortInfo> {
  const segmentsByName = new Map<string, string[]>();
  const nameBySegmentKey = new Map<string, string>();
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (segmentsByName.has(normalized)) continue;

    const segments = nameSegments(name);
    segmentsByName.set(normalized, segments);
    const segmentKey = segments.join("_");
    if (!nameBySegmentKey.has(segmentKey)) nameBySegmentKey.set(segmentKey, normalized);
  }

  const resolved = new Map<string, PrefixSortInfo>();

  const resolve = (name: string): PrefixSortInfo => {
    const cached = resolved.get(name);
    if (cached) return cached;

    const segments = segmentsByName.get(name) ?? [];
    let bestAnchor: { name: string; segmentCount: number; start: number } | undefined;

    for (let segmentCount = segments.length - 1; segmentCount > 0 && !bestAnchor; segmentCount -= 1) {
      for (let start = 0; start <= segments.length - segmentCount; start += 1) {
        const candidateName = nameBySegmentKey.get(segments.slice(start, start + segmentCount).join("_"));
        if (!candidateName || candidateName === name) continue;
        bestAnchor = { name: candidateName, segmentCount, start };
        break;
      }
    }

    if (!bestAnchor) {
      const info = { rootName: name, leadingSegments: 0 };
      resolved.set(name, info);
      return info;
    }

    const anchor = resolve(bestAnchor.name);
    const rootSegments = segmentsByName.get(anchor.rootName) ?? [];
    const rootStart = findSubsequence(segments, rootSegments);
    const info = {
      rootName: anchor.rootName,
      leadingSegments: rootStart >= 0 ? rootStart : bestAnchor.start + anchor.leadingSegments,
    };
    resolved.set(name, info);
    return info;
  };

  for (const name of segmentsByName.keys()) resolve(name);
  return resolved;
}

function comparePrefixPriorityNames(left: string, right: string, index: ReadonlyMap<string, PrefixSortInfo>): number {
  const leftName = left.toLowerCase();
  const rightName = right.toLowerCase();
  const leftInfo = index.get(leftName) ?? { rootName: leftName, leadingSegments: 0 };
  const rightInfo = index.get(rightName) ?? { rootName: rightName, leadingSegments: 0 };

  const rootCompared = databaseObjectNameCollator.compare(leftInfo.rootName, rightInfo.rootName);
  if (rootCompared !== 0) return rootCompared;

  if (leftInfo.leadingSegments !== rightInfo.leadingSegments) {
    return leftInfo.leadingSegments - rightInfo.leadingSegments;
  }

  return databaseObjectNameCollator.compare(left, right);
}

export function createDatabaseObjectNameComparator(names: readonly string[]): (left: string, right: string) => number {
  const index = buildPrefixSortIndex(names);
  return (left, right) => comparePrefixPriorityNames(left, right, index);
}

export function sortDatabaseObjectsByPrefixPriority<T>(items: readonly T[], getName: (item: T) => string): T[] {
  const compareNames = createDatabaseObjectNameComparator(items.map(getName));
  return [...items].sort((left, right) => compareNames(getName(left), getName(right)));
}

export function sortDatabaseObjectsByName<T>(items: readonly T[], getName: (item: T) => string): T[] {
  return [...items].sort((left, right) => databaseObjectNameCollator.compare(getName(left), getName(right)));
}

export function mergeTableInfosIntoObjects(
  objects: readonly ObjectInfo[],
  tables: readonly TableInfo[],
  schema?: string,
): ObjectInfo[] {
  const merged = [...objects];
  const seen = new Set(
    merged.map((obj) => {
      const name = normalizeDatabaseObjectName(obj.name);
      const objectSchema = obj.schema ? normalizeDatabaseObjectName(obj.schema) : schema || "";
      return `${normalizeObjectType(obj.object_type)}\0${objectSchema.toLowerCase()}\0${name.toLowerCase()}`;
    }),
  );

  for (const table of tables) {
    const objectType = normalizeObjectType(table.table_type);
    if (objectType !== "TABLE" && objectType !== "VIEW") continue;
    const name = normalizeDatabaseObjectName(table.name);
    if (!name) continue;
    const matchingObject = objects.find((obj) => {
      const objName = normalizeDatabaseObjectName(obj.name);
      if (objName.toLowerCase() !== name.toLowerCase()) return false;
      return normalizeObjectType(obj.object_type) === objectType;
    });
    const tableSchema =
      schema ?? (matchingObject?.schema ? normalizeDatabaseObjectName(matchingObject.schema) : undefined);
    const key = `${objectType}\0${(tableSchema || "").toLowerCase()}\0${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      name,
      object_type: objectType,
      schema: tableSchema,
      comment: table.comment,
      created_at: undefined,
      updated_at: undefined,
      parent_schema: table.parent_schema,
      parent_name: table.parent_name,
    });
  }

  return merged;
}

function buildPartitionTree(entries: TableTreeEntry[], connectionId: string, database: string): TreeNode[] {
  const orderedEntries = sortDatabaseObjectsByName(entries, (entry) => entry.node.label);
  const byKey = new Map<string, TableTreeEntry>();
  for (const entry of orderedEntries) {
    byKey.set(entry.key, entry);
  }

  const childrenByParent = new Map<string, TableTreeEntry[]>();
  const childKeys = new Set<string>();
  for (const entry of orderedEntries) {
    if (entry.objectType !== "TABLE" || !entry.parentName) continue;
    const parentSchema = entry.parentSchema || entry.schema;
    const parentKey = objectIdentityKey("TABLE", parentSchema, entry.parentName);
    const parent = byKey.get(parentKey);
    if (!parent || parent.key === entry.key) continue;
    const children = childrenByParent.get(parent.key) ?? [];
    children.push(entry);
    childrenByParent.set(parent.key, children);
    childKeys.add(entry.key);
  }

  const materialize = (entry: TableTreeEntry): TreeNode => {
    const partitionChildren = childrenByParent.get(entry.key);
    if (!partitionChildren?.length) return entry.node;

    const partitionGroup: TreeNode = {
      id: `${entry.node.id}:__partitions`,
      label: "tree.partitions",
      type: "group-partitions",
      connectionId,
      database,
      schema: entry.schema,
      tableName: entry.node.label,
      objectCount: partitionChildren.length,
      isExpanded: false,
      children: partitionChildren.map(materialize),
    };
    entry.node.children = [partitionGroup];
    entry.node.hiddenChildren = [partitionGroup];
    return entry.node;
  };

  return orderedEntries.filter((entry) => !childKeys.has(entry.key)).map(materialize);
}

function partitionGroupChildren(node: TreeNode): TreeNode[] {
  const children = node.children?.filter((child) => child.type === "group-partitions") ?? [];
  if (children.length) return children;
  return node.hiddenChildren?.filter((child) => child.type === "group-partitions") ?? [];
}

export function tablePartitionGroups(node: TreeNode): TreeNode[] {
  return partitionGroupChildren(node);
}

export function hasTablePartitionGroups(node: TreeNode): boolean {
  return partitionGroupChildren(node).length > 0;
}

type DatabaseObjectTreeKind = "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION" | "PACKAGE" | "PACKAGE_BODY";

function buildObjectTreeEntries({
  nodeId,
  connectionId,
  database,
  schema,
  objects,
  objectType,
}: {
  nodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  objects: ObjectInfo[];
  objectType: "TABLE" | "VIEW";
}): TreeNode[] {
  const entries = objects.flatMap((obj) => {
    const name = normalizeDatabaseObjectName(obj.name);
    if (!name) return [];
    const childSchema = obj.schema ? normalizeDatabaseObjectName(obj.schema) : schema;
    return [
      makeTableTreeEntry({
        nodeId,
        connectionId,
        database,
        schema: childSchema,
        name,
        objectType,
        comment: obj.comment,
        parentSchema: obj.parent_schema,
        parentName: obj.parent_name,
      }),
    ];
  });

  return buildPartitionTree(entries, connectionId, database);
}

export function buildSimpleObjectTreeNodes({
  nodeId,
  connectionId,
  database,
  schema,
  objects,
}: {
  nodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  objects: ObjectInfo[];
}): TreeNode[] {
  const seen = new Set<string>();
  const tableEntries: TableTreeEntry[] = [];
  const viewNodes: TreeNode[] = [];

  for (const obj of objects) {
    const objectType = normalizeObjectType(obj.object_type);
    if (objectType !== "TABLE" && objectType !== "VIEW" && objectType !== "PACKAGE" && objectType !== "PACKAGE_BODY")
      continue;

    const name = normalizeDatabaseObjectName(obj.name);
    if (!name) continue;

    const childSchema = obj.schema ? normalizeDatabaseObjectName(obj.schema) : schema;
    const dedupeKey = `${objectType}\0${(childSchema || "").toLowerCase()}\0${name.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const entry = makeTableTreeEntry({
      nodeId,
      connectionId,
      database,
      schema: childSchema,
      name,
      objectType,
      comment: obj.comment,
      parentSchema: obj.parent_schema,
      parentName: obj.parent_name,
    });
    if (objectType === "TABLE") {
      tableEntries.push(entry);
    } else if (objectType === "VIEW") {
      viewNodes.push(entry.node);
    } else {
      viewNodes.push({
        id: `${nodeId}:${childSchema ? `${childSchema}:` : ""}${name}:${objectType}`,
        label: name,
        type: objectType === "PACKAGE_BODY" ? "package-body" : "package",
        comment: obj.comment,
        connectionId,
        database,
        schema: childSchema,
        isExpanded: false,
        children: undefined,
      });
    }
  }

  return [
    ...buildPartitionTree(tableEntries, connectionId, database),
    ...sortDatabaseObjectsByName(viewNodes, (node) => node.label),
  ];
}

function normalizeObjectType(type: string): DatabaseObjectTreeKind {
  const v = type.toUpperCase();
  if (v.includes("PACKAGE BODY") || v.includes("PACKAGE_BODY")) return "PACKAGE_BODY";
  if (v.includes("PACKAGE")) return "PACKAGE";
  if (v.includes("VIEW")) return "VIEW";
  if (v.includes("PROC")) return "PROCEDURE";
  if (v.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}

const groupDefs: Array<{
  key: string;
  label: string;
  objectTypes: DatabaseObjectTreeKind[];
  nodeType: TreeNodeType;
  childType: TreeNodeType | ((objectType: DatabaseObjectTreeKind) => TreeNodeType);
}> = [
  { key: "__tables", label: "tree.tables", objectTypes: ["TABLE"], nodeType: "group-tables", childType: "table" },
  { key: "__views", label: "tree.views", objectTypes: ["VIEW"], nodeType: "group-views", childType: "view" },
  {
    key: "__procedures",
    label: "tree.procedures",
    objectTypes: ["PROCEDURE"],
    nodeType: "group-procedures",
    childType: "procedure",
  },
  {
    key: "__functions",
    label: "tree.functions",
    objectTypes: ["FUNCTION"],
    nodeType: "group-functions",
    childType: "function",
  },
  {
    key: "__packages",
    label: "tree.packages",
    objectTypes: ["PACKAGE", "PACKAGE_BODY"],
    nodeType: "group-packages",
    childType: (objectType) => (objectType === "PACKAGE_BODY" ? "package-body" : "package"),
  },
];

const objectGroupNodeTypes = new Set<TreeNodeType>([
  "group-tables",
  "group-views",
  "group-procedures",
  "group-functions",
  "group-packages",
]);

export function objectGroupRefreshParentId(node: TreeNode): string | null {
  if (!objectGroupNodeTypes.has(node.type)) return null;
  const suffixStart = node.id.lastIndexOf(":__");
  if (suffixStart < 0) return null;
  return node.id.slice(0, suffixStart);
}

export function buildGroupedObjectTreeNodes({
  nodeId,
  connectionId,
  database,
  schema,
  objects,
}: {
  nodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  objects: ObjectInfo[];
}): TreeNode[] {
  const buckets = new Map<string, ObjectInfo[]>();
  const seen = new Set<string>();
  for (const obj of objects) {
    const name = normalizeDatabaseObjectName(obj.name);
    if (!name) continue;
    const t = normalizeObjectType(obj.object_type);
    const objectSchema = obj.schema ? normalizeDatabaseObjectName(obj.schema) : schema || "";
    const key = `${t}\0${objectSchema.toLowerCase()}\0${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const arr = buckets.get(t) ?? [];
    arr.push({ ...obj, name, schema: obj.schema ? normalizeDatabaseObjectName(obj.schema) : obj.schema });
    buckets.set(t, arr);
  }

  const groups: TreeNode[] = [];
  for (const def of groupDefs) {
    const items = def.objectTypes.flatMap((objectType) => buckets.get(objectType) ?? []);
    if (!items?.length) continue;
    const isExpandable = def.nodeType === "group-tables" || def.nodeType === "group-views";
    const children = isExpandable
      ? buildObjectTreeEntries({
          nodeId: `${nodeId}:${def.key}`,
          connectionId,
          database,
          schema,
          objects: items,
          objectType: def.objectTypes[0] as "TABLE" | "VIEW",
        })
      : sortDatabaseObjectsByName(items, (obj) => obj.name).map((obj) => {
          const childSchema = obj.schema ? normalizeDatabaseObjectName(obj.schema) : schema;
          const objectType = normalizeObjectType(obj.object_type);
          const childType = typeof def.childType === "function" ? def.childType(objectType) : def.childType;
          const objectTypeSuffix = objectType === "PACKAGE" || objectType === "PACKAGE_BODY" ? `:${objectType}` : "";
          return {
            id: `${nodeId}:${def.key}:${childSchema ? `${childSchema}:` : ""}${obj.name}${objectTypeSuffix}`,
            label: obj.name,
            type: childType,
            comment: obj.comment,
            connectionId,
            database,
            schema: childSchema,
            isExpanded: false,
            children: undefined,
          };
        });
    groups.push({
      id: `${nodeId}:${def.key}`,
      label: def.label,
      type: def.nodeType,
      connectionId,
      database,
      schema,
      objectCount: items.length,
      isExpanded: false,
      children,
    });
  }
  return groups;
}

export function expandCachedObjectBrowserNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => {
    if (node.type === "object-browser") return node.hiddenChildren ?? [];

    if (!node.children) return [node];

    return [
      {
        ...node,
        children: expandCachedObjectBrowserNodes(node.children),
      },
    ];
  });
}
