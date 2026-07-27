import type { ObjectInfo, TableInfo, TreeNode, TreeNodeType } from "@/types/database";
import { normalizeSidebarObjectKind, type SidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";

const databaseObjectNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function normalizeDatabaseObjectName(name: string): string {
  return name.trim();
}

export function buildTableTreeNodes({ nodeId, connectionId, database, schema, tables, catalog }: { nodeId: string; connectionId: string; database: string; schema?: string; tables: TableInfo[]; catalog?: string }): TreeNode[] {
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
        tableType: table.table_type,
        comment: table.comment,
        parentSchema: table.parent_schema,
        parentName: table.parent_name,
        catalog,
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
  tableType,
  comment,
  parentSchema,
  parentName,
  catalog,
}: {
  nodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  includeSchemaInId?: boolean;
  name: string;
  objectType: DatabaseObjectTreeKind;
  tableType?: string;
  comment?: string | null;
  parentSchema?: string | null;
  parentName?: string | null;
  catalog?: string;
}): TableTreeEntry {
  const normalizedParentSchema = parentSchema ? normalizeDatabaseObjectName(parentSchema) : undefined;
  const normalizedParentName = parentName ? normalizeDatabaseObjectName(parentName) : undefined;
  const nodeIdSchemaSuffix = includeSchemaInId !== false && schema ? `${schema}:` : "";
  const node: TreeNode = {
    id: `${nodeId}:${nodeIdSchemaSuffix}${name}`,
    label: name,
    type: objectType === "VIEW" ? ("view" as const) : objectType === "MATERIALIZED_VIEW" ? ("materialized_view" as const) : ("table" as const),
    tableType,
    comment,
    connectionId,
    database,
    schema,
    catalog,
    isExpanded: false,
    children: [],
  };
  if (normalizedParentSchema) node.partitionParentSchema = normalizedParentSchema;
  if (normalizedParentName) node.partitionParentName = normalizedParentName;

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

// Shared with the object browser so both sides of the UI list objects in the
// same natural visible-name order as the sidebar tree (issue #3604).
export function compareDatabaseObjectNames(left: string, right: string): number {
  return databaseObjectNameCollator.compare(left, right);
}

export function mergeTableInfosIntoObjects(objects: readonly ObjectInfo[], tables: readonly TableInfo[], schema?: string): ObjectInfo[] {
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
    if (objectType !== "TABLE" && objectType !== "VIEW" && objectType !== "MATERIALIZED_VIEW") continue;
    const name = normalizeDatabaseObjectName(table.name);
    if (!name) continue;
    const matchingObject = objects.find((obj) => {
      const objName = normalizeDatabaseObjectName(obj.name);
      if (objName.toLowerCase() !== name.toLowerCase()) return false;
      return normalizeObjectType(obj.object_type) === objectType;
    });
    const tableSchema = schema ?? (matchingObject?.schema ? normalizeDatabaseObjectName(matchingObject.schema) : undefined);
    const key = `${objectType}\0${(tableSchema || "").toLowerCase()}\0${name.toLowerCase()}`;
    if (seen.has(key)) {
      // Table already in objects — merge comment if missing
      if (matchingObject && table.comment && !matchingObject.comment) {
        matchingObject.comment = table.comment;
      }
      continue;
    }
    seen.add(key);
    merged.push({
      name,
      // Keep original driver-reported type (e.g. TDengine STABLE) so
      // downstream template strategies can distinguish special table kinds.
      object_type: table.table_type,
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

export function filterSimpleSidebarSupplementalObjects(objects: readonly ObjectInfo[]): ObjectInfo[] {
  return objects.filter((object) => {
    const objectType = normalizeObjectType(object.object_type);
    return objectType !== "TABLE" && objectType !== "VIEW" && objectType !== "MATERIALIZED_VIEW";
  });
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
      label: childTableGroupLabel(entry.node),
      type: "group-partitions",
      connectionId,
      database,
      schema: entry.schema,
      catalog: entry.node.catalog,
      tableName: entry.node.label,
      objectCount: partitionChildren.length,
      isExpanded: isSuperTable(entry.node),
      children: partitionChildren.map(materialize),
    };
    entry.node.children = [partitionGroup];
    entry.node.hiddenChildren = [partitionGroup];
    return entry.node;
  };

  return orderedEntries.filter((entry) => !childKeys.has(entry.key)).map(materialize);
}

function isSuperTable(parent: TreeNode): boolean {
  return parent.tableType?.trim().toUpperCase() === "STABLE";
}

function childTableGroupLabel(parent: TreeNode): string {
  return isSuperTable(parent) ? "tree.childTables" : "tree.partitions";
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

export type TableTreeLoadMoreParent = {
  schema?: string | null;
  name: string;
};

function findTableTreeNode(nodes: readonly TreeNode[], parent: TableTreeLoadMoreParent): TreeNode | undefined {
  for (const node of nodes) {
    const sameSchema = !parent.schema || (node.schema || "").toLowerCase() === parent.schema.toLowerCase();
    if (node.type === "table" && sameSchema && node.label.toLowerCase() === parent.name.toLowerCase()) return node;

    const child = findTableTreeNode(node.children ?? [], parent);
    if (child) return child;
    const hiddenChild = findTableTreeNode(node.hiddenChildren?.filter((item) => !(node.children ?? []).includes(item)) ?? [], parent);
    if (hiddenChild) return hiddenChild;
  }
  return undefined;
}

export function appendTableTreeLoadMoreNode(children: TreeNode[], loadMoreNode: TreeNode, parent?: TableTreeLoadMoreParent): TreeNode[] {
  const parentNode = parent ? findTableTreeNode(children, parent) : undefined;
  // Only TDengine pages are scoped to a STABLE's child-table group. PostgreSQL
  // paginates the whole schema, so nesting its global cursor under whichever
  // partition happens to end the page can hide all remaining schema objects.
  const childGroup = parentNode && isSuperTable(parentNode) ? tablePartitionGroups(parentNode)[0] : undefined;
  if (!childGroup) return [...children, loadMoreNode];

  childGroup.children = [...(childGroup.children ?? []), loadMoreNode];
  return children;
}

export function withoutTableTreeLoadMoreNodes(nodes: TreeNode[] | undefined): TreeNode[] {
  return (nodes ?? [])
    .filter((node) => node.type !== "load-more")
    .map((node) => {
      if (node.children) node.children = withoutTableTreeLoadMoreNodes(node.children);
      if (node.hiddenChildren) node.hiddenChildren = withoutTableTreeLoadMoreNodes(node.hiddenChildren);
      return node;
    });
}

export function mergeTableTreePageChildren(currentChildren: TreeNode[], pageChildren: TreeNode[], connectionId: string, database: string): TreeNode[] {
  const roots = [...currentChildren];
  const nodesByKey = new Map<string, TreeNode>();
  const rootKeys = new Set<string>();

  const nodeKey = (node: TreeNode) => objectIdentityKey("TABLE", node.schema, node.label);
  const collect = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "table") {
        nodesByKey.set(nodeKey(node), node);
      }
      collect(node.children ?? []);
      collect(node.hiddenChildren?.filter((child) => !(node.children ?? []).includes(child)) ?? []);
    }
  };

  collect(roots);
  for (const node of roots) {
    if (node.type === "table") rootKeys.add(nodeKey(node));
  }

  const ensurePartitionGroup = (parent: TreeNode): TreeNode => {
    const existing = partitionGroupChildren(parent)[0];
    if (existing) return existing;
    const group: TreeNode = {
      id: `${parent.id}:__partitions`,
      label: childTableGroupLabel(parent),
      type: "group-partitions",
      connectionId,
      database,
      schema: parent.schema,
      tableName: parent.label,
      objectCount: 0,
      isExpanded: isSuperTable(parent),
      children: [],
    };
    parent.children = [...(parent.children ?? []), group];
    parent.hiddenChildren = [...(parent.hiddenChildren ?? []), group];
    return group;
  };

  const addToParent = (parent: TreeNode, child: TreeNode) => {
    const group = ensurePartitionGroup(parent);
    const children = group.children ?? [];
    if (!children.some((node) => nodeKey(node) === nodeKey(child))) {
      group.children = sortDatabaseObjectsByName([...children, child], (node) => node.label);
      group.objectCount = group.children.length;
    }
  };

  const addNode = (node: TreeNode) => {
    if (node.type !== "table") {
      roots.push(node);
      return;
    }

    const key = nodeKey(node);
    if (nodesByKey.has(key)) return;

    const parentName = node.partitionParentName;
    const parentSchema = node.partitionParentSchema || node.schema;
    const parentKey = parentName ? objectIdentityKey("TABLE", parentSchema, parentName) : "";
    const parent = parentKey ? nodesByKey.get(parentKey) : undefined;
    nodesByKey.set(key, node);
    if (parent && parent !== node) {
      addToParent(parent, node);
      return;
    }

    if (!rootKeys.has(key)) {
      roots.push(node);
      rootKeys.add(key);
    }
  };

  const flattenIncomingTables = (node: TreeNode): TreeNode[] => {
    if (node.type !== "table") return [node];
    const descendants = partitionGroupChildren(node)
      .flatMap((group) => group.children ?? [])
      .flatMap(flattenIncomingTables);
    node.children = (node.children ?? []).filter((child) => child.type !== "group-partitions");
    node.hiddenChildren = (node.hiddenChildren ?? []).filter((child) => child.type !== "group-partitions");
    return [node, ...descendants];
  };

  for (const node of pageChildren.flatMap(flattenIncomingTables)) {
    addNode(node);
  }

  return sortDatabaseObjectsByName(roots, (node) => node.label);
}

export type DatabaseObjectTreeKind = SidebarObjectKind;

function buildObjectTreeEntries({ nodeId, connectionId, database, schema, objects, objectType }: { nodeId: string; connectionId: string; database: string; schema?: string; objects: ObjectInfo[]; objectType: "TABLE" | "VIEW" | "MATERIALIZED_VIEW" }): TreeNode[] {
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
        tableType: obj.object_type,
        comment: obj.comment,
        parentSchema: obj.parent_schema,
        parentName: obj.parent_name,
      }),
    ];
  });

  return buildPartitionTree(entries, connectionId, database);
}

export function buildSimpleObjectTreeNodes({ nodeId, connectionId, database, schema, objects }: { nodeId: string; connectionId: string; database: string; schema?: string; objects: ObjectInfo[] }): TreeNode[] {
  const seen = new Set<string>();
  const tableEntries: TableTreeEntry[] = [];
  const objectNodes: TreeNode[] = [];

  for (const obj of objects) {
    const objectType = normalizeObjectType(obj.object_type);
    if (!["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY"].includes(objectType)) {
      continue;
    }

    const name = normalizeDatabaseObjectName(obj.name);
    if (!name) continue;

    const childSchema = obj.schema ? normalizeDatabaseObjectName(obj.schema) : schema;
    const signature = obj.signature?.trim() || "";
    const dedupeKey = `${objectType}\0${(childSchema || "").toLowerCase()}\0${name.toLowerCase()}\0${signature.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const entry = makeTableTreeEntry({
      nodeId,
      connectionId,
      database,
      schema: childSchema,
      name,
      objectType,
      tableType: obj.object_type,
      comment: obj.comment,
      parentSchema: obj.parent_schema,
      parentName: obj.parent_name,
    });
    if (objectType === "TABLE") {
      tableEntries.push(entry);
    } else {
      const simpleNodeType = simpleObjectNodeType(objectType);
      objectNodes.push({
        id: objectType === "VIEW" || objectType === "MATERIALIZED_VIEW" ? entry.node.id : `${nodeId}:${childSchema ? `${childSchema}:` : ""}${name}:${signature}:${objectType}`,
        label: signature && (objectType === "FUNCTION" || objectType === "PROCEDURE") ? `${name}(${signature})` : name,
        type: simpleNodeType,
        objectName: name,
        signature: signature || undefined,
        comment: obj.comment,
        valid: obj.valid ?? undefined,
        connectionId,
        database,
        schema: childSchema,
        isExpanded: false,
        children: undefined,
      });
    }
  }

  return [...buildPartitionTree(tableEntries, connectionId, database), ...sortDatabaseObjectsByName(objectNodes, (node) => node.label)];
}

function simpleObjectNodeType(objectType: DatabaseObjectTreeKind): TreeNodeType {
  if (objectType === "VIEW") return "view";
  if (objectType === "MATERIALIZED_VIEW") return "materialized_view";
  if (objectType === "PROCEDURE") return "procedure";
  if (objectType === "FUNCTION") return "function";
  if (objectType === "TRIGGER") return "trigger";
  if (objectType === "SEQUENCE") return "sequence";
  if (objectType === "PACKAGE_BODY") return "package-body";
  if (objectType === "PACKAGE") return "package";
  if (objectType === "TYPE_BODY") return "type-body";
  if (objectType === "TYPE") return "type";
  return "table";
}

function normalizeObjectType(type: string): DatabaseObjectTreeKind {
  return normalizeSidebarObjectKind(type);
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
    key: "__materialized_views",
    label: "tree.materializedViews",
    objectTypes: ["MATERIALIZED_VIEW"],
    nodeType: "group-materialized-views",
    childType: "materialized_view",
  },
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
    key: "__triggers",
    label: "tree.triggers",
    objectTypes: ["TRIGGER"],
    nodeType: "group-triggers",
    childType: "trigger",
  },
  {
    key: "__sequences",
    label: "tree.sequences",
    objectTypes: ["SEQUENCE"],
    nodeType: "group-sequences",
    childType: "sequence",
  },
  {
    key: "__packages",
    label: "tree.packages",
    objectTypes: ["PACKAGE", "PACKAGE_BODY"],
    nodeType: "group-packages",
    childType: (objectType) => (objectType === "PACKAGE_BODY" ? "package-body" : "package"),
  },
  {
    key: "__types",
    label: "tree.types",
    objectTypes: ["TYPE", "TYPE_BODY"],
    nodeType: "group-types",
    childType: (objectType) => (objectType === "TYPE_BODY" ? "type-body" : "type"),
  },
];

const objectGroupNodeTypes = new Set<TreeNodeType>(["group-tables", "group-views", "group-materialized-views", "group-procedures", "group-functions", "group-triggers", "group-sequences", "group-packages", "group-types"]);

export function buildObjectGroupPlaceholderNodes({ nodeId, connectionId, database, schema, objectTypes }: { nodeId: string; connectionId: string; database: string; schema?: string; objectTypes: DatabaseObjectTreeKind[] }): TreeNode[] {
  const supported = new Set(objectTypes);
  return groupDefs
    .filter((def) => def.objectTypes.some((objectType) => supported.has(objectType)))
    .map((def) => ({
      id: `${nodeId}:${def.key}`,
      label: def.label,
      type: def.nodeType,
      connectionId,
      database,
      schema,
      isExpanded: false,
      children: [],
    }));
}

export function objectGroupRefreshParentId(node: TreeNode): string | null {
  if (!objectGroupNodeTypes.has(node.type)) return null;
  const suffixStart = node.id.lastIndexOf(":__");
  if (suffixStart < 0) return null;
  return node.id.slice(0, suffixStart);
}

export function objectTypesForGroupNode(type: TreeNodeType): DatabaseObjectTreeKind[] | null {
  return groupDefs.find((def) => def.nodeType === type)?.objectTypes ?? null;
}

export function buildGroupedObjectTreeNodes({ nodeId, connectionId, database, schema, objects }: { nodeId: string; connectionId: string; database: string; schema?: string; objects: ObjectInfo[] }): TreeNode[] {
  const buckets = new Map<string, ObjectInfo[]>();
  const seen = new Set<string>();
  for (const obj of objects) {
    const name = normalizeDatabaseObjectName(obj.name);
    if (!name) continue;
    const t = normalizeObjectType(obj.object_type);
    const objectSchema = obj.schema ? normalizeDatabaseObjectName(obj.schema) : schema || "";
    const signature = (obj.signature ?? "").trim();
    const key = `${t}\0${objectSchema.toLowerCase()}\0${name.toLowerCase()}\0${signature.toLowerCase()}`;
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
    const isExpandable = def.nodeType === "group-tables" || def.nodeType === "group-views" || def.nodeType === "group-materialized-views";
    const children = isExpandable
      ? buildObjectTreeEntries({
          nodeId: `${nodeId}:${def.key}`,
          connectionId,
          database,
          schema,
          objects: items,
          objectType: def.objectTypes[0] as "TABLE" | "VIEW" | "MATERIALIZED_VIEW",
        })
      : sortDatabaseObjectsByName(items, (obj) => obj.name).map((obj) => {
          const childSchema = obj.schema ? normalizeDatabaseObjectName(obj.schema) : schema;
          const objectType = normalizeObjectType(obj.object_type);
          const childType = typeof def.childType === "function" ? def.childType(objectType) : def.childType;
          const objectTypeSuffix = objectType === "PACKAGE" || objectType === "PACKAGE_BODY" || objectType === "TYPE" || objectType === "TYPE_BODY" ? `:${objectType}` : "";
          const signature = obj.signature?.trim() || "";
          const signatureIdPart = signature && (objectType === "FUNCTION" || objectType === "PROCEDURE") ? `:${signature}` : "";
          return {
            id: `${nodeId}:${def.key}:${childSchema ? `${childSchema}:` : ""}${obj.name}${signatureIdPart}${objectTypeSuffix}`,
            label: signature && (objectType === "FUNCTION" || objectType === "PROCEDURE") ? `${obj.name}(${signature})` : obj.name,
            type: childType,
            objectName: obj.name,
            signature: signature || undefined,
            comment: obj.comment,
            valid: obj.valid ?? undefined,
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
