import { qualifiedTableKey } from "./docsKeys";
import type { SchemaSnapshot } from "./types";

export interface SearchHit {
  kind: "table" | "column" | "group" | "enum";
  label: string;
  /** Where the hit lives — a qualified table name, or a count for groups. */
  context: string;
  /** Qualified table name for navigation, or null for groups and enums. */
  tableKey: string | null;
}

/** Per-kind result caps. A single overall cap lets columns — by far the most
 *  numerous kind — crowd groups and enums out of the list entirely. */
const LIMITS = { table: 20, column: 20, group: 10, enum: 10 } as const;

/**
 * Case-insensitive substring search over the whole snapshot.
 *
 * Tables rank first: someone typing a table's name almost always wants the
 * table, not a column that happens to share the word.
 *
 * Results are capped per kind — see LIMITS. This is the only place results are
 * limited; callers render everything they are handed.
 */
export function searchDocs(snapshot: SchemaSnapshot, query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }

  const tables: SearchHit[] = [];
  const columns: SearchHit[] = [];

  for (const table of snapshot.tables) {
    const key = qualifiedTableKey(table);
    if (table.name.toLowerCase().includes(needle)) {
      tables.push({ kind: "table", label: table.name, context: key, tableKey: key });
    }
    for (const column of table.columns) {
      if (column.name.toLowerCase().includes(needle)) {
        columns.push({ kind: "column", label: column.name, context: key, tableKey: key });
      }
    }
  }

  const groups: SearchHit[] = snapshot.groups
    .filter((group) => group.name.toLowerCase().includes(needle))
    .map((group) => ({
      kind: "group",
      label: group.name,
      context: `${snapshot.tables.filter((table) => table.groupId === group.id).length} tables`,
      tableKey: null,
    }));

  const enums: SearchHit[] = snapshot.enums
    .filter((value) => value.name.toLowerCase().includes(needle))
    .map((value) => ({
      kind: "enum",
      label: value.name,
      context: `${value.values.length} values`,
      tableKey: null,
    }));

  return [...tables.slice(0, LIMITS.table), ...columns.slice(0, LIMITS.column), ...groups.slice(0, LIMITS.group), ...enums.slice(0, LIMITS.enum)];
}
