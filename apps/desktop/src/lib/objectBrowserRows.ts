import type { ObjectInfo } from "@/types/database";
import { createDatabaseObjectNameComparator, normalizeDatabaseObjectName } from "@/lib/tableTree";
import { parseSlashDelimitedRegexQuery } from "@/lib/searchPattern";

export type ObjectBrowserRow = {
  id: string;
  name: string;
  schema?: string;
  type: "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "SEQUENCE" | "PACKAGE" | "PACKAGE_BODY";
  comment?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  partitionParentId?: string;
  partitionCount?: number;
  partitionParentSchema?: string;
  partitionParentName?: string;
};

export type ObjectBrowserSortKey = "name" | "type" | "created_at" | "updated_at" | "comment";
export type ObjectBrowserSortDirection = "asc" | "desc";

export function normalizeObjectBrowserType(type: string): ObjectBrowserRow["type"] {
  const value = type.toUpperCase();
  if (value.includes("PACKAGE BODY") || value.includes("PACKAGE_BODY")) return "PACKAGE_BODY";
  if (value.includes("PACKAGE")) return "PACKAGE";
  if (value.includes("MATERIALIZED_VIEW")) return "MATERIALIZED_VIEW";
  if (value.includes("VIEW")) return "VIEW";
  if (value.includes("SEQ")) return "SEQUENCE";
  if (value.includes("PROC")) return "PROCEDURE";
  if (value.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}

export function buildObjectBrowserRows(options: { objects: ObjectInfo[]; database: string; fallbackSchema: string; needsSchema: boolean }): ObjectBrowserRow[] {
  const seen = new Map<string, number>();
  const rows = options.objects.flatMap((object) => {
    const name = normalizeDatabaseObjectName(object.name);
    if (!name) return [];
    const objectSchema = object.schema ? normalizeDatabaseObjectName(object.schema) : undefined;
    const schema = objectSchema || (options.needsSchema ? options.fallbackSchema : undefined);
    const type = normalizeObjectBrowserType(object.object_type);
    const baseId = `${schema || options.fallbackSchema || options.database}:${name}:${type}`;
    const index = seen.get(baseId) ?? 0;
    seen.set(baseId, index + 1);
    return [
      {
        id: `${baseId}:${index}`,
        name,
        schema,
        type,
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
    return rows.filter((row) => [row.name, row.type, row.comment].filter(Boolean).some((value) => regex.test(String(value))));
  }
  return rows.filter((row) => [row.name, row.type, row.comment].filter(Boolean).some((value) => String(value).toLowerCase().includes(q)));
}

export function sortObjectBrowserRows(rows: ObjectBrowserRow[], key: ObjectBrowserSortKey, direction: ObjectBrowserSortDirection): ObjectBrowserRow[] {
  const multiplier = direction === "asc" ? 1 : -1;
  const compareNames = createDatabaseObjectNameComparator(rows.map((row) => row.name));
  return [...rows].sort((left, right) => {
    const compared = key === "name" ? compareNames(left.name, right.name) : compareObjectBrowserValue(left[key], right[key], key, direction);
    if (compared !== 0) return compared * multiplier;
    return compareNames(left.name, right.name);
  });
}

export function initialObjectBrowserSortDirection(key: ObjectBrowserSortKey): ObjectBrowserSortDirection {
  return key === "created_at" || key === "updated_at" ? "desc" : "asc";
}

export function formatObjectBrowserTimestamp(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return "";
  return text
    .replace("T", " ")
    .replace(/\.\d+(?=$|[+-]\d{2}(?::?\d{2})?$)/, "")
    .replace(/(?:Z|[+-]\d{2}(?::?\d{2})?)$/, "");
}

function compareObjectBrowserValue(left: string | null | undefined, right: string | null | undefined, key: ObjectBrowserSortKey, direction: ObjectBrowserSortDirection): number {
  const leftText = normalizeSortValue(left);
  const rightText = normalizeSortValue(right);
  if (!leftText && !rightText) return 0;
  if (!leftText) return direction === "asc" ? 1 : -1;
  if (!rightText) return direction === "asc" ? -1 : 1;
  if (key === "created_at" || key === "updated_at") return leftText.localeCompare(rightText);
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: "base" });
}

function normalizeSortValue(value: string | null | undefined): string {
  return value?.trim() ?? "";
}
