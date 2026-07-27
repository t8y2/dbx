import type { ObjectInfo, TreeNode, TreeNodeType } from "@/types/database";
import { pinnedTreeNodeIdentityMatches, type PinnedTreeNodeIdentity } from "@/lib/app/pinnedItems";
import { buildGroupedObjectTreeNodes, buildSimpleObjectTreeNodes, buildTableTreeNodes, compareDatabaseObjectNames, normalizeDatabaseObjectName } from "@/lib/table/tableTree";
import { parseSlashDelimitedRegexQuery } from "@/lib/common/searchPattern";

export type ObjectBrowserRow = {
  id: string;
  name: string;
  displayName: string;
  schema?: string;
  type: "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "PACKAGE" | "PACKAGE_BODY" | "TYPE" | "TYPE_BODY";
  valid?: boolean | null;
  signature?: string | null;
  comment?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  partitionParentId?: string;
  partitionCount?: number;
  partitionParentSchema?: string;
  partitionParentName?: string;
  estimatedRows?: number | null;
  totalBytes?: number | null;
};

export type ObjectBrowserSortKey = "name" | "type" | "estimatedRows" | "totalBytes" | "created_at" | "updated_at" | "comment";
export type ObjectBrowserSortDirection = "asc" | "desc";
export type ObjectBrowserFilter = "all" | "tables" | "views" | "materializedViews" | "procedures" | "functions" | "triggers" | "sequences" | "packages" | "types";
export type ObjectBrowserFilterCounts = Record<ObjectBrowserFilter, number>;

export type ObjectBrowserPinnedTreeNodeContext = {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  sidebarParentId?: string;
};

export function objectBrowserRowTreeNodeType(type: ObjectBrowserRow["type"]): TreeNodeType {
  if (type === "TABLE") return "table";
  if (type === "VIEW") return "view";
  if (type === "MATERIALIZED_VIEW") return "materialized_view";
  if (type === "PROCEDURE") return "procedure";
  if (type === "FUNCTION") return "function";
  if (type === "TRIGGER") return "trigger";
  if (type === "SEQUENCE") return "sequence";
  if (type === "PACKAGE_BODY") return "package-body";
  if (type === "PACKAGE") return "package";
  if (type === "TYPE_BODY") return "type-body";
  return "type";
}

export function canonicalObjectBrowserPinnedTreeNodeIdentity(identity: PinnedTreeNodeIdentity, database: string): PinnedTreeNodeIdentity {
  // Some drivers expose database-level objects with the selected database as
  // their schema, while the sidebar represents the same objects without one.
  // Canonicalize only this alias; real schemas remain distinct.
  return identity.schema === database ? { ...identity, schema: "" } : identity;
}

export function canonicalizeObjectBrowserPinnedTreeNodeIdentity(context: ObjectBrowserPinnedTreeNodeContext): (identity: PinnedTreeNodeIdentity) => PinnedTreeNodeIdentity {
  return (identity) => canonicalObjectBrowserPinnedTreeNodeIdentity(identity, context.database);
}

export function objectBrowserRowPinnedTreeNodeIdentity(row: ObjectBrowserRow, context: ObjectBrowserPinnedTreeNodeContext): PinnedTreeNodeIdentity {
  return {
    connectionId: context.connectionId,
    database: context.database,
    schema: row.schema ?? context.schema ?? "",
    catalog: context.catalog || "",
    type: objectBrowserRowTreeNodeType(row.type),
    name: row.name,
    signature: row.type === "FUNCTION" || row.type === "PROCEDURE" ? row.signature?.trim() || "" : "",
    id: row.id,
  };
}

export function objectBrowserRowMatchesPinnedTreeNode(row: ObjectBrowserRow, identity: PinnedTreeNodeIdentity, context: ObjectBrowserPinnedTreeNodeContext): boolean {
  return pinnedTreeNodeIdentityMatches(identity, objectBrowserRowPinnedTreeNodeIdentity(row, context), canonicalizeObjectBrowserPinnedTreeNodeIdentity(context));
}

function flattenTreeNodeIds(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...(node.children ? flattenTreeNodeIds(node.children) : [])]);
}

function objectBrowserRowObjectInfo(row: ObjectBrowserRow, schema?: string): ObjectInfo {
  return {
    name: row.name,
    object_type: row.type,
    schema,
    signature: row.signature || undefined,
    parent_schema: row.partitionParentSchema,
    parent_name: row.partitionParentName,
  };
}

function legacySchemaCandidates(row: ObjectBrowserRow, context: ObjectBrowserPinnedTreeNodeContext): Array<string | undefined> {
  const identity = objectBrowserRowPinnedTreeNodeIdentity(row, context);
  const canonicalIdentity = canonicalizeObjectBrowserPinnedTreeNodeIdentity(context)(identity);
  return [...new Set([row.schema, context.schema, canonicalIdentity.schema, undefined].map((schema) => schema?.trim() || undefined))];
}

/**
 * Builds the historical bare IDs emitted by each sidebar layout. The current
 * v2 key is identity-based, but old persisted pins contain only these IDs.
 */
export function objectBrowserRowLegacyPinnedTreeNodeIds(row: ObjectBrowserRow, context: ObjectBrowserPinnedTreeNodeContext): string[] {
  const parentId = context.sidebarParentId || `${context.connectionId}:${context.database}`;
  const legacyIds = new Set<string>();
  for (const schema of legacySchemaCandidates(row, context)) {
    const object = objectBrowserRowObjectInfo(row, schema);
    const simpleNodes =
      row.type === "TABLE" || row.type === "VIEW" || row.type === "MATERIALIZED_VIEW"
        ? buildTableTreeNodes({
            nodeId: parentId,
            connectionId: context.connectionId,
            database: context.database,
            schema,
            tables: [
              {
                name: row.name,
                table_type: row.type,
                comment: row.comment,
                parent_schema: row.partitionParentSchema,
                parent_name: row.partitionParentName,
              },
            ],
          })
        : buildSimpleObjectTreeNodes({ nodeId: parentId, connectionId: context.connectionId, database: context.database, schema, objects: [object] });
    for (const id of flattenTreeNodeIds(simpleNodes)) legacyIds.add(id);

    const groupedNodes = buildGroupedObjectTreeNodes({ nodeId: parentId, connectionId: context.connectionId, database: context.database, schema, objects: [object] });
    for (const group of groupedNodes) {
      for (const id of flattenTreeNodeIds(group.children || [])) legacyIds.add(id);
    }
  }
  return [...legacyIds];
}

export function normalizeObjectBrowserType(type: string): ObjectBrowserRow["type"] {
  const value = type.toUpperCase();
  const normalized = value.replace(/[\s-]+/g, "_");
  if (normalized.includes("PACKAGE_BODY")) return "PACKAGE_BODY";
  if (normalized.includes("TYPE_BODY")) return "TYPE_BODY";
  if (normalized.includes("PACKAGE")) return "PACKAGE";
  if (normalized.includes("TRIGGER")) return "TRIGGER";
  if (normalized.includes("TYPE")) return "TYPE";
  if (normalized.includes("MATERIALIZED_VIEW")) return "MATERIALIZED_VIEW";
  if (value.includes("VIEW")) return "VIEW";
  if (value.includes("SEQ")) return "SEQUENCE";
  if (value.includes("PROC")) return "PROCEDURE";
  if (value.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}

export function buildObjectBrowserRows(options: { objects: ObjectInfo[]; database: string; fallbackSchema: string; rowSchema?: string }): ObjectBrowserRow[] {
  const seen = new Map<string, number>();
  const rows = options.objects.flatMap((object) => {
    const name = normalizeDatabaseObjectName(object.name);
    if (!name) return [];
    const objectSchema = object.schema ? normalizeDatabaseObjectName(object.schema) : undefined;
    const schema = objectSchema || options.rowSchema;
    const type = normalizeObjectBrowserType(object.object_type);
    const signature = routineSignatureForDisplay(type, object.signature);
    const displayName = signature === undefined ? name : `${name}(${signature})`;
    const signatureIdPart = signature === undefined ? "" : `:${signature}`;
    const baseId = `${schema || options.fallbackSchema || options.database}:${name}:${type}${signatureIdPart}`;
    const index = seen.get(baseId) ?? 0;
    seen.set(baseId, index + 1);
    return [
      {
        id: `${baseId}:${index}`,
        name,
        displayName,
        schema,
        type,
        valid: object.valid,
        signature,
        comment: object.comment,
        created_at: object.created_at,
        updated_at: object.updated_at,
        partitionParentSchema: object.parent_schema ? normalizeDatabaseObjectName(object.parent_schema) : undefined,
        partitionParentName: object.parent_name ? normalizeDatabaseObjectName(object.parent_name) : undefined,
      },
    ];
  });

  markPartitionRows(rows, options.fallbackSchema || options.database);
  return rows;
}

function routineSignatureForDisplay(type: ObjectBrowserRow["type"], signature: string | null | undefined): string | undefined {
  if (type !== "PROCEDURE" && type !== "FUNCTION") return undefined;
  if (signature == null) return undefined;
  return signature.trim();
}

function markPartitionRows(rows: ObjectBrowserRow[], fallbackSchema: string) {
  const tableByKey = new Map<string, ObjectBrowserRow>();
  for (const row of rows) {
    if (row.type !== "TABLE") continue;
    tableByKey.set(objectKey(row, fallbackSchema), row);
  }

  const partitionCountByParent = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== "TABLE") continue;
    const parentName = row.partitionParentName || partitionParentName(row.name);
    if (!parentName) continue;
    const parentKey = objectKey({ ...row, schema: row.partitionParentSchema || row.schema, name: parentName }, fallbackSchema);
    const parent = tableByKey.get(parentKey);
    if (!parent || parent.id === row.id) continue;
    row.partitionParentId = parent.id;
    partitionCountByParent.set(parent.id, (partitionCountByParent.get(parent.id) ?? 0) + 1);
  }

  for (const row of rows) {
    row.partitionCount = partitionCountByParent.get(row.id);
  }
}

function objectKey(row: Pick<ObjectBrowserRow, "schema" | "name" | "type">, fallbackSchema: string) {
  return `${row.type}\0${(row.schema || fallbackSchema).toLowerCase()}\0${row.name.toLowerCase()}`;
}

function partitionParentName(name: string): string | null {
  const match = /^(.*)_p\d{4,}$/.exec(name);
  return match?.[1] || null;
}

export function filterObjectBrowserRows(rows: ObjectBrowserRow[], query: string): ObjectBrowserRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const regex = parseSlashDelimitedRegexQuery(query.trim());
  if (regex) {
    return rows.filter((row) => [row.displayName, row.name, row.type, row.comment].filter(Boolean).some((value) => regex.test(String(value))));
  }
  return rows.filter((row) => [row.displayName, row.name, row.type, row.comment].filter(Boolean).some((value) => String(value).toLowerCase().includes(q)));
}

export function countObjectBrowserRowsByFilter(rows: ObjectBrowserRow[]): ObjectBrowserFilterCounts {
  const counts: ObjectBrowserFilterCounts = {
    all: rows.length,
    tables: 0,
    views: 0,
    materializedViews: 0,
    procedures: 0,
    functions: 0,
    triggers: 0,
    sequences: 0,
    packages: 0,
    types: 0,
  };

  for (const row of rows) {
    if (row.type === "TABLE") counts.tables++;
    else if (row.type === "VIEW") counts.views++;
    else if (row.type === "MATERIALIZED_VIEW") counts.materializedViews++;
    else if (row.type === "PROCEDURE") counts.procedures++;
    else if (row.type === "FUNCTION") counts.functions++;
    else if (row.type === "TRIGGER") counts.triggers++;
    else if (row.type === "SEQUENCE") counts.sequences++;
    else if (row.type === "PACKAGE" || row.type === "PACKAGE_BODY") counts.packages++;
    else if (row.type === "TYPE" || row.type === "TYPE_BODY") counts.types++;
  }

  return counts;
}

export function summarizeObjectBrowserSearch(rows: ObjectBrowserRow[], query: string): { matchingRows: ObjectBrowserRow[]; counts: ObjectBrowserFilterCounts } {
  const matchingRows = filterObjectBrowserRows(rows, query);
  return { matchingRows, counts: countObjectBrowserRowsByFilter(matchingRows) };
}

export function sortObjectBrowserRows(rows: ObjectBrowserRow[], key: ObjectBrowserSortKey, direction: ObjectBrowserSortDirection): ObjectBrowserRow[] {
  const multiplier = direction === "asc" ? 1 : -1;
  // Sort by natural visible name, matching the sidebar tree ordering
  // (see fix "keep tables sorted by visible name" and issue #3604).
  return [...rows].sort((left, right) => {
    const compared = key === "name" ? compareDatabaseObjectNames(left.displayName, right.displayName) : compareObjectBrowserValue(left[key], right[key], key, direction);
    if (compared !== 0) return compared * multiplier;
    return compareDatabaseObjectNames(left.displayName, right.displayName);
  });
}

export function initialObjectBrowserSortDirection(key: ObjectBrowserSortKey): ObjectBrowserSortDirection {
  return key === "created_at" || key === "updated_at" || key === "estimatedRows" || key === "totalBytes" ? "desc" : "asc";
}

export function formatObjectBrowserTimestamp(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return "";
  return text
    .replace("T", " ")
    .replace(/\.\d+(?=$|[+-]\d{2}(?::?\d{2})?$)/, "")
    .replace(/(?:Z|[+-]\d{2}(?::?\d{2})?)$/, "");
}

export function formatObjectBrowserCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat().format(value);
}

export function formatObjectBrowserBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = Math.max(0, value);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  const fractionDigits = unitIndex === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function compareObjectBrowserValue(left: string | number | null | undefined, right: string | number | null | undefined, key: ObjectBrowserSortKey, direction: ObjectBrowserSortDirection): number {
  if (key === "estimatedRows" || key === "totalBytes") {
    return compareObjectBrowserNumber(left, right, direction);
  }
  const leftText = normalizeSortValue(left);
  const rightText = normalizeSortValue(right);
  if (!leftText && !rightText) return 0;
  if (!leftText) return direction === "asc" ? 1 : -1;
  if (!rightText) return direction === "asc" ? -1 : 1;
  if (key === "created_at" || key === "updated_at") return leftText.localeCompare(rightText);
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: "base" });
}

function compareObjectBrowserNumber(left: string | number | null | undefined, right: string | number | null | undefined, direction: ObjectBrowserSortDirection): number {
  const leftNumber = normalizeSortNumber(left);
  const rightNumber = normalizeSortNumber(right);
  if (leftNumber === null && rightNumber === null) return 0;
  if (leftNumber === null) return direction === "asc" ? 1 : -1;
  if (rightNumber === null) return direction === "asc" ? -1 : 1;
  return leftNumber - rightNumber;
}

function normalizeSortValue(value: string | number | null | undefined): string {
  if (typeof value === "number") return String(value);
  return value?.trim() ?? "";
}

function normalizeSortNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
