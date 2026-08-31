import type { TableInfo } from "@/types/database";
import type { SchemaDiffCompareOptions } from "@/types/schemaDiff";

export interface CompiledSchemaDiffTableFilter {
  include?: RegExp;
  exclude?: RegExp;
  priority: SchemaDiffCompareOptions["tableFilterPriority"];
}

export interface FilteredSchemaDiffTables {
  sourceTables: TableInfo[];
  targetTables: TableInfo[];
}

function compilePattern(pattern: string, label: "include" | "exclude"): RegExp | undefined {
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;
  try {
    return new RegExp(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} table name regex: ${message}`);
  }
}

export function compileSchemaDiffTableFilter(options: SchemaDiffCompareOptions): CompiledSchemaDiffTableFilter {
  return {
    include: compilePattern(options.tableIncludePattern, "include"),
    exclude: compilePattern(options.tableExcludePattern, "exclude"),
    priority: options.tableFilterPriority,
  };
}

export function matchesSchemaDiffTableFilter(tableName: string, filter: CompiledSchemaDiffTableFilter): boolean {
  const includeMatches = filter.include ? filter.include.test(tableName) : true;
  const excludeMatches = filter.exclude ? filter.exclude.test(tableName) : false;

  if (filter.include && filter.exclude && includeMatches && excludeMatches) {
    return filter.priority === "include";
  }
  return includeMatches && !excludeMatches;
}

export function isSchemaDiffView(table: Pick<TableInfo, "table_type">): boolean {
  return table.table_type.toUpperCase().replace(/\s+/g, "_").includes("VIEW");
}

function isSchemaDiffObjectEnabled(table: TableInfo, options: Pick<SchemaDiffCompareOptions, "tables" | "views">): boolean {
  return isSchemaDiffView(table) ? options.views : options.tables;
}

export function filterSchemaDiffTables(sourceTables: TableInfo[], targetTables: TableInfo[], filter: CompiledSchemaDiffTableFilter, options: Pick<SchemaDiffCompareOptions, "tables" | "views"> = { tables: true, views: true }, selectedTables?: string[]): FilteredSchemaDiffTables {
  // Visual (explicit) table selection is applied first, then the existing include/exclude
  // regex filter. Source and target use the SAME selected table set, so targets are matched
  // by the same name and any target missing a same-name table simply drops out (surfaced to
  // the user in the UI as "missing"). Semantics:
  //   - `undefined`: no visual restriction — legacy all-tables behavior + regex filter.
  //   - `[]`: restriction explicitly enabled with an empty selection — compare nothing.
  //   - `["a", "b"]`: restrict to exactly those table names.
  const selectedSet = selectedTables === undefined ? null : new Set(selectedTables);
  const includeTable = (table: TableInfo) => isSchemaDiffObjectEnabled(table, options) && (!selectedSet || selectedSet.has(table.name)) && matchesSchemaDiffTableFilter(table.name, filter);

  return {
    sourceTables: sourceTables.filter(includeTable),
    targetTables: targetTables.filter(includeTable),
  };
}
