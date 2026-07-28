import type { OpenTableDefaultSortMode } from "@/stores/settingsStore";
import type { DatabaseType, QueryTab } from "@/types/database";
import { quoteTableDataIdentifier } from "@/lib/table/tableSelectSql";

export type TableDefaultSortDirection = "asc" | "desc";

export interface OpenTableDefaultSort {
  column: string;
  columnIndex: number;
  direction: TableDefaultSortDirection;
  orderBy: string;
}

export function buildPrimaryKeyOrderBy(options: { databaseType?: DatabaseType; identifierQuote?: string; primaryKeys: string[]; direction: TableDefaultSortDirection }): string | undefined {
  if (options.primaryKeys.length === 0) return undefined;
  const direction = options.direction.toUpperCase();
  const prefix = options.databaseType === "neo4j" ? "n." : "";
  return options.primaryKeys.map((primaryKey) => `${prefix}${quoteTableDataIdentifier(options.databaseType, primaryKey, options.identifierQuote)} ${direction}`).join(", ");
}

export function buildOpenTableDefaultSort(options: { mode: OpenTableDefaultSortMode; databaseType?: DatabaseType; identifierQuote?: string; primaryKeys: string[]; columns: string[] }): OpenTableDefaultSort | undefined {
  if (options.mode === "none") return undefined;
  const column = options.primaryKeys[0];
  if (!column) return undefined;
  const direction = options.mode === "primary-key-desc" ? "desc" : "asc";
  const orderBy = buildPrimaryKeyOrderBy({
    databaseType: options.databaseType,
    identifierQuote: options.identifierQuote,
    primaryKeys: options.primaryKeys,
    direction,
  });
  if (!orderBy) return undefined;
  return {
    column,
    columnIndex: options.columns.indexOf(column),
    direction,
    orderBy,
  };
}

export function shouldApplyOpenTableDefaultSort(tab: QueryTab, orderBy?: string): boolean {
  const trimmedOrderBy = orderBy?.trim();
  if (tab.openTableDefaultSortApplied) {
    const defaultOrderBy = tab.openTableDefaultSortOrderBy?.trim();
    return !trimmedOrderBy || (!!defaultOrderBy && trimmedOrderBy === defaultOrderBy);
  }
  return !trimmedOrderBy && !tab.resultSortColumn && !tab.resultSortDirection && !tab.orderByInput?.trim();
}

export function applyOpenTableDefaultSortState(tab: QueryTab, sort: OpenTableDefaultSort | undefined): void {
  if (!sort) {
    tab.resultSortColumn = undefined;
    tab.resultSortColumnIndex = undefined;
    tab.resultSortDirection = undefined;
    tab.resultSortMode = undefined;
    tab.orderByInput = undefined;
    tab.openTableDefaultSortApplied = undefined;
    tab.openTableDefaultSortOrderBy = undefined;
    return;
  }
  tab.resultSortColumn = sort.column;
  tab.resultSortColumnIndex = sort.columnIndex >= 0 ? sort.columnIndex : undefined;
  tab.resultSortDirection = sort.direction;
  tab.resultSortMode = "database";
  tab.orderByInput = sort.orderBy;
  tab.openTableDefaultSortApplied = true;
  tab.openTableDefaultSortOrderBy = sort.orderBy;
}

export function clearOpenTableDefaultSortMarker(tab: QueryTab): void {
  tab.openTableDefaultSortApplied = undefined;
  tab.openTableDefaultSortOrderBy = undefined;
}
