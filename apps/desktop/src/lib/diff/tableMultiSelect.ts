/**
 * Pure selection/filtering helpers for the shared TableMultiSelect UI.
 *
 * These are framework-agnostic (no Vue state) so the behavior of the shared
 * multi-table selector can be unit-tested independently of any component
 * mount infrastructure, and so the same logic backs both Data Compare and
 * Schema Diff table selection.
 */

/** Case-insensitive substring filter over table names. An empty/whitespace query returns all tables. */
export function filterTableNames(tables: string[], query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return tables;
  return tables.filter((table) => table.toLowerCase().includes(trimmed));
}

/** Toggle a single table name within a selection list (preserves order, no duplicates). */
export function toggleTableName(selected: string[], table: string): string[] {
  if (selected.includes(table)) {
    return selected.filter((name) => name !== table);
  }
  return [...selected, table];
}

/** True when every entry of `filtered` is already present in `selected`. */
export function isEveryFilteredSelected(selected: string[], filtered: string[]): boolean {
  return filtered.length > 0 && filtered.every((table) => selected.includes(table));
}

/**
 * Select every table in `filtered` if not all are selected; otherwise deselect them all.
 * Only tables within `filtered` are touched — the rest of `selected` is preserved, so
 * selecting-all after a search only affects the current filtered subset.
 */
export function toggleSelectFiltered(selected: string[], filtered: string[]): string[] {
  const next = new Set(selected);
  if (isEveryFilteredSelected(selected, filtered)) {
    filtered.forEach((table) => next.delete(table));
  } else {
    filtered.forEach((table) => next.add(table));
  }
  return [...next];
}
