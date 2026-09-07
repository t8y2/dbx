import type { SchemaDiffTableMapping } from "@/types/schemaDiff";

export type SchemaDiffTableMatchKind = "automatic" | "manual" | "unmatched";

export interface SchemaDiffTableMatch {
  sourceTable: string;
  targetTable?: string;
  kind: SchemaDiffTableMatchKind;
}

export interface SchemaDiffTableMappingUpdate {
  mappings: SchemaDiffTableMapping[];
  accepted: boolean;
  conflictSource?: string;
}

function firstMappingBySource(mappings: readonly SchemaDiffTableMapping[]): Map<string, string> {
  const bySource = new Map<string, string>();
  for (const mapping of mappings) {
    if (!mapping.sourceTable || !mapping.targetTable || bySource.has(mapping.sourceTable)) continue;
    bySource.set(mapping.sourceTable, mapping.targetTable);
  }
  return bySource;
}

/** Keep mappings for selected source tables while preserving their current target, even if the target list is loading. */
export function pruneSchemaDiffTableMappings(selectedTables: readonly string[], mappings: readonly SchemaDiffTableMapping[]): SchemaDiffTableMapping[] {
  const selected = new Set(selectedTables);
  const seenSources = new Set<string>();
  return mappings.filter((mapping) => {
    if (!selected.has(mapping.sourceTable) || !mapping.targetTable || seenSources.has(mapping.sourceTable)) return false;
    seenSources.add(mapping.sourceTable);
    return true;
  });
}

/**
 * Reconcile explicit mappings with the current source and target lists.
 * Explicit mappings win when valid; otherwise a same-name target is tried.
 * A target can only be consumed once, so stale duplicate mappings cannot leak
 * into the comparison request.
 */
export function reconcileSchemaDiffTableMappings(selectedTables: readonly string[], targetTables: readonly string[], mappings: readonly SchemaDiffTableMapping[]): SchemaDiffTableMapping[] {
  const targets = new Set(targetTables);
  const explicitBySource = firstMappingBySource(mappings);
  const usedTargets = new Set<string>();
  const next: SchemaDiffTableMapping[] = [];

  for (const sourceTable of selectedTables) {
    if (!sourceTable) continue;

    let targetTable = explicitBySource.get(sourceTable);
    if (!targetTable || !targets.has(targetTable) || usedTargets.has(targetTable)) {
      targetTable = targets.has(sourceTable) && !usedTargets.has(sourceTable) ? sourceTable : undefined;
    }

    if (!targetTable) continue;
    usedTargets.add(targetTable);
    next.push({ sourceTable, targetTable });
  }

  return next;
}

export function buildSchemaDiffTableMatches(selectedTables: readonly string[], targetTables: readonly string[], mappings: readonly SchemaDiffTableMapping[]): SchemaDiffTableMatch[] {
  const reconciled = reconcileSchemaDiffTableMappings(selectedTables, targetTables, mappings);
  const targetBySource = new Map(reconciled.map((mapping) => [mapping.sourceTable, mapping.targetTable]));

  return selectedTables.map((sourceTable) => {
    const targetTable = targetBySource.get(sourceTable);
    let kind: SchemaDiffTableMatchKind;
    if (!targetTable) kind = "unmatched";
    else if (targetTable === sourceTable) kind = "automatic";
    else kind = "manual";
    return { sourceTable, targetTable, kind };
  });
}

/** Update one mapping and reject a target already assigned to another source. */
export function updateSchemaDiffTableMapping(mappings: readonly SchemaDiffTableMapping[], sourceTable: string, targetTable: string): SchemaDiffTableMappingUpdate {
  const conflict = mappings.find((mapping) => mapping.sourceTable !== sourceTable && mapping.targetTable === targetTable);
  if (targetTable && conflict) {
    return { mappings: [...mappings], accepted: false, conflictSource: conflict.sourceTable };
  }

  return {
    mappings: [...mappings.filter((mapping) => mapping.sourceTable !== sourceTable), ...(targetTable ? [{ sourceTable, targetTable }] : [])],
    accepted: true,
  };
}

/** Hide targets occupied by another source while retaining the current value for the edited row. */
export function availableSchemaDiffTargetTables(sourceTable: string, targetTables: readonly string[], mappings: readonly SchemaDiffTableMapping[]): string[] {
  const currentTarget = mappings.find((mapping) => mapping.sourceTable === sourceTable)?.targetTable;
  const occupiedTargets = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.sourceTable !== sourceTable) occupiedTargets.add(mapping.targetTable);
  }
  return targetTables.filter((targetTable) => targetTable === currentTarget || !occupiedTargets.has(targetTable));
}

/** Reverse source/target for swap, dropping malformed duplicate targets defensively. */
export function swapSchemaDiffTableMappings(mappings: readonly SchemaDiffTableMapping[]): SchemaDiffTableMapping[] {
  const usedTargets = new Set<string>();
  const swapped: SchemaDiffTableMapping[] = [];
  for (const mapping of mappings) {
    if (!mapping.sourceTable || !mapping.targetTable || usedTargets.has(mapping.sourceTable)) continue;
    usedTargets.add(mapping.sourceTable);
    swapped.push({ sourceTable: mapping.targetTable, targetTable: mapping.sourceTable });
  }
  return swapped;
}

export function areSchemaDiffTableMappingsEqual(left: readonly SchemaDiffTableMapping[], right: readonly SchemaDiffTableMapping[]): boolean {
  return left.length === right.length && left.every((mapping, index) => mapping.sourceTable === right[index]?.sourceTable && mapping.targetTable === right[index]?.targetTable);
}
