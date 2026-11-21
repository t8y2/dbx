/**
 * Query results can contain duplicate column labels, e.g.
 * `SELECT a.name, b.name, c.name ...` (#12452). The grid, sorting, filtering
 * and copy paths all look columns up by name, so duplicates make them address
 * the first match only.
 *
 * Rename duplicates once at the result boundary, Navicat-style:
 * `name, name, name` -> `name, name_1, name_2`. Existing names are never
 * reused, so a result that already contains `name_1` stays unambiguous.
 */
export function dedupeResultColumnNames(columns: readonly string[]): string[] {
  const used = new Set<string>();
  return columns.map((column) => {
    if (!used.has(column)) {
      used.add(column);
      return column;
    }
    let suffix = 1;
    let candidate = `${column}_${suffix}`;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${column}_${suffix}`;
    }
    used.add(candidate);
    return candidate;
  });
}
