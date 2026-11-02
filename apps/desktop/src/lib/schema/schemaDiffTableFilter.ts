import type { TableInfo } from "@/types/database";
import { reconcileSchemaDiffTableMappings } from "@/lib/schema/schemaDiffTableMapping";
import type { SchemaDiffCompareOptions } from "@/types/schemaDiff";

export interface CompiledSchemaDiffTableFilter {
  include?: RegExp;
  exclude?: RegExp[];
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

function compileExcludePatterns(input: string): RegExp[] | undefined {
  const patterns: RegExp[] = [];
  let start = 0;
  let escaped = false;
  let inCharacterClass = false;
  let groupDepth = 0;
  let braceDepth = 0;
  const appendPattern = (end: number) => {
    const pattern = compilePattern(input.slice(start, end), "exclude");
    if (pattern) patterns.push(pattern);
  };

  // Split only outer commas; regex groups, character classes, quantifiers and
  // escaped commas remain part of their rule. Compile rules separately so
  // numbered backreferences do not change meaning across rules.
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (char === "]") inCharacterClass = false;
      continue;
    }
    if (char === "[") inCharacterClass = true;
    else if (char === "(") groupDepth++;
    else if (char === ")") groupDepth = Math.max(0, groupDepth - 1);
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "," && groupDepth === 0 && braceDepth === 0) {
      appendPattern(index);
      start = index + 1;
    }
  }
  appendPattern(input.length);
  return patterns.length > 0 ? patterns : undefined;
}

export function compileSchemaDiffTableFilter(options: SchemaDiffCompareOptions): CompiledSchemaDiffTableFilter {
  return {
    include: compilePattern(options.tableIncludePattern, "include"),
    exclude: compileExcludePatterns(options.tableExcludePattern),
    priority: options.tableFilterPriority,
  };
}

export function matchesSchemaDiffTableFilter(tableName: string, filter: CompiledSchemaDiffTableFilter): boolean {
  const includeMatches = filter.include ? filter.include.test(tableName) : true;
  const excludeMatches = filter.exclude?.some((pattern) => pattern.test(tableName)) ?? false;

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

type SchemaDiffTableFilterOptions = Pick<SchemaDiffCompareOptions, "tables" | "views" | "ignoreTableNameCase"> & {
  tableMappings?: SchemaDiffCompareOptions["tableMappings"];
};

export function filterSchemaDiffTables(sourceTables: TableInfo[], targetTables: TableInfo[], filter: CompiledSchemaDiffTableFilter, options: SchemaDiffTableFilterOptions = { tables: true, views: true, ignoreTableNameCase: false }, selectedTables?: string[]): FilteredSchemaDiffTables {
  // Visual (explicit) table selection is applied first, then the existing include/exclude
  // regex filter. With an explicit selection, targets are selected by the effective
  // source→target mapping; without one, the legacy all-tables path is unchanged.
  const selectedSet = selectedTables === undefined ? null : new Set(selectedTables);
  const includeTable = (table: TableInfo) => isSchemaDiffObjectEnabled(table, options) && matchesSchemaDiffTableFilter(table.name, filter);
  const filteredSourceTables = sourceTables.filter((table) => includeTable(table) && (!selectedSet || selectedSet.has(table.name)));
  const filteredTargetTables = targetTables.filter(includeTable);

  if (!selectedSet) {
    return { sourceTables: filteredSourceTables, targetTables: filteredTargetTables };
  }

  const selectedTargetNames = new Set(
    reconcileSchemaDiffTableMappings(
      filteredSourceTables.map((table) => table.name),
      filteredTargetTables.map((table) => table.name),
      options.tableMappings ?? [],
      options.ignoreTableNameCase,
    ).map((mapping) => mapping.targetTable),
  );

  return {
    sourceTables: filteredSourceTables,
    targetTables: filteredTargetTables.filter((table) => selectedTargetNames.has(table.name)),
  };
}
