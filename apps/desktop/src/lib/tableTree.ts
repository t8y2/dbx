import type { ObjectInfo, TableInfo, TreeNode, TreeNodeType } from "@/types/database";

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
  objectType: "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION";
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
  objectType: "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION";
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

function buildPartitionTree(entries: TableTreeEntry[], connectionId: string, database: string): TreeNode[] {
  const byKey = new Map<string, TableTreeEntry>();
  for (const entry of entries) {
    byKey.set(entry.key, entry);
  }

  const childrenByParent = new Map<string, TableTreeEntry[]>();
  const childKeys = new Set<string>();
  for (const entry of entries) {
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

  return entries.filter((entry) => !childKeys.has(entry.key)).map(materialize);
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
    if (objectType !== "TABLE" && objectType !== "VIEW") continue;

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
    } else {
      viewNodes.push(entry.node);
    }
  }

  return [...buildPartitionTree(tableEntries, connectionId, database), ...viewNodes];
}

function normalizeObjectType(type: string): "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION" {
  const v = type.toUpperCase();
  if (v.includes("VIEW")) return "VIEW";
  if (v.includes("PROC")) return "PROCEDURE";
  if (v.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}

const groupDefs: Array<{
  key: string;
  label: string;
  objectType: string;
  nodeType: TreeNodeType;
  childType: TreeNodeType;
}> = [
  { key: "__tables", label: "tree.tables", objectType: "TABLE", nodeType: "group-tables", childType: "table" },
  { key: "__views", label: "tree.views", objectType: "VIEW", nodeType: "group-views", childType: "view" },
  {
    key: "__procedures",
    label: "tree.procedures",
    objectType: "PROCEDURE",
    nodeType: "group-procedures",
    childType: "procedure",
  },
  {
    key: "__functions",
    label: "tree.functions",
    objectType: "FUNCTION",
    nodeType: "group-functions",
    childType: "function",
  },
];

const objectGroupNodeTypes = new Set<TreeNodeType>([
  "group-tables",
  "group-views",
  "group-procedures",
  "group-functions",
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
    const items = buckets.get(def.objectType);
    if (!items?.length) continue;
    const isExpandable = def.childType === "table" || def.childType === "view";
    const children = isExpandable
      ? buildObjectTreeEntries({
          nodeId: `${nodeId}:${def.key}`,
          connectionId,
          database,
          schema,
          objects: items,
          objectType: def.objectType as "TABLE" | "VIEW",
        })
      : items.map((obj) => {
          const childSchema = obj.schema ? normalizeDatabaseObjectName(obj.schema) : schema;
          return {
            id: `${nodeId}:${def.key}:${childSchema ? `${childSchema}:` : ""}${obj.name}`,
            label: obj.name,
            type: def.childType,
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
