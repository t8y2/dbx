export type StructureColumnSortDirection = "asc" | "desc";

export interface StructureColumnViewSort {
  key: string;
  direction: StructureColumnSortDirection;
}

export type StructureColumnSortValue = string | boolean | null | undefined;

export interface StructureColumnSortRow<T> {
  column: T;
  /** Position in the real table structure; the ordinal shown in the # column. */
  ordinal: number;
}

function isBlank(value: StructureColumnSortValue): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function compareValues(left: StructureColumnSortValue, right: StructureColumnSortValue): number {
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  const leftText = left === null || left === undefined ? "" : String(left);
  const rightText = right === null || right === undefined ? "" : String(right);
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * View-only ordering for the column grid. Rows keep their `ordinal` so the #
 * column and every index-based handler still refer to the real table order.
 */
export function sortStructureColumnRows<T>(rows: readonly StructureColumnSortRow<T>[], sort: StructureColumnViewSort, valueOf: (column: T, key: string) => StructureColumnSortValue): StructureColumnSortRow<T>[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  return rows
    .map((row, position) => ({ row, position, value: valueOf(row.column, sort.key) }))
    .sort((left, right) => {
      const leftBlank = isBlank(left.value);
      const rightBlank = isBlank(right.value);
      // Blank values stay last in both directions.
      if (leftBlank !== rightBlank) return leftBlank ? 1 : -1;
      if (leftBlank && rightBlank) return left.position - right.position;
      const compared = compareValues(left.value, right.value);
      return compared !== 0 ? compared * factor : left.position - right.position;
    })
    .map(({ row }) => row);
}
