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

export function filterSchemaDiffTables(sourceTables: TableInfo[], targetTables: TableInfo[], filter: CompiledSchemaDiffTableFilter, options: Pick<SchemaDiffCompareOptions, "tables" | "views"> = { tables: true, views: true }): FilteredSchemaDiffTables {
  const includeTable = (table: TableInfo) => isSchemaDiffObjectEnabled(table, options) && matchesSchemaDiffTableFilter(table.name, filter);

  return {
    sourceTables: sourceTables.filter(includeTable),
    targetTables: targetTables.filter(includeTable),
  };
}
