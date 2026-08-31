/**
 * Same-name target table matching, shared by Data Compare and Schema Diff.
 * Given the selected source table set and the available target tables, produces
 * which source tables matched a same-name target and which are missing.
 */
export interface SameNameTableMatchResult {
  matched: string[];
  missing: string[];
}

export function buildSameNameTableMatches(sourceTables: string[], targetTables: string[]): SameNameTableMatchResult {
  const targetSet = new Set(targetTables);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const source of sourceTables) {
    if (targetSet.has(source)) {
      matched.push(source);
    } else {
      missing.push(source);
    }
  }
  return { matched, missing };
}
