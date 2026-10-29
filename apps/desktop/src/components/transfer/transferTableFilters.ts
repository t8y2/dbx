import type { DatabaseType } from "@/types/database";

/**
 * Source engines whose rows a data transfer can filter per table.
 *
 * The dialog uses this to decide whether it can offer the editor, and the
 * backend decides whether it can page the read, so the two lists must agree.
 * `transfer_table_filter_supported` in `crates/dbx-core/src/data/transfer.rs`
 * is the source of truth; `cargo test -p dbx-core
 * transfer_table_filter_types_match_the_desktop_list` fails when this file drifts.
 */
export const TRANSFER_TABLE_FILTER_TYPES = ["mysql", "gbase", "postgres", "kingbase", "gaussdb", "opengauss", "kwdb", "dameng", "oracle", "oceanbase-oracle", "sqlserver", "sqlite"] as const satisfies readonly DatabaseType[];

const TRANSFER_TABLE_FILTER_TYPE_SET: ReadonlySet<string> = new Set<string>(TRANSFER_TABLE_FILTER_TYPES);

/** True when a transfer can filter this source engine's rows. */
export function transferTableFilterSupported(dbType: DatabaseType | string | null | undefined): boolean {
  return typeof dbType === "string" && TRANSFER_TABLE_FILTER_TYPE_SET.has(dbType);
}

/**
 * Filters that still apply to the current selection, keyed by table and sorted
 * by table name. A filter for a deselected table stays in the draft — reselecting
 * the table restores it — but is never sent with the transfer.
 */
export function selectedTableFilters(filters: Record<string, string>, selectedTables: Iterable<string>): Record<string, string> {
  const selected = selectedTables instanceof Set ? selectedTables : new Set(selectedTables);
  return Object.fromEntries(
    Object.entries(filters)
      .filter(([table, value]) => selected.has(table) && value.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** How many selected tables currently carry a filter. */
export function countSelectedTableFilters(filters: Record<string, string>, selectedTables: Iterable<string>): number {
  return Object.keys(selectedTableFilters(filters, selectedTables)).length;
}
