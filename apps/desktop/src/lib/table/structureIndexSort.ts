export type StructureIndexColumnSort = "asc" | "desc";

/**
 * Sorts index drafts by their key-column list (#12550). The joined column list
 * keeps composite indexes grouped by their leading column; the primary key
 * always stays first because it is the table identity, not a maintenance index.
 */
export function sortStructureIndexesByColumns<T extends { columns: readonly string[]; isPrimary: boolean }>(indexes: readonly T[], direction: StructureIndexColumnSort): T[] {
  const factor = direction === "asc" ? 1 : -1;
  const sorted = [...indexes].sort((left, right) => {
    const leftKey = left.columns.join("\u0000").toLowerCase();
    const rightKey = right.columns.join("\u0000").toLowerCase();
    return leftKey.localeCompare(rightKey) * factor;
  });
  return [...sorted.filter((index) => index.isPrimary), ...sorted.filter((index) => !index.isPrimary)];
}
