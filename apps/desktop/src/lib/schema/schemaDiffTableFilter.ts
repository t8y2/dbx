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

export function filterSchemaDiffTables(sourceTables: TableInfo[], targetTables: TableInfo[], filter: CompiledSchemaDiffTableFilter): FilteredSchemaDiffTables {
  return {
    sourceTables: sourceTables.filter((table) => matchesSchemaDiffTableFilter(table.name, filter)),
    targetTables: targetTables.filter((table) => matchesSchemaDiffTableFilter(table.name, filter)),
  };
}
