import type { QueryResult } from "@/types/database";

export function toChartNumber(value: QueryResult["rows"][number][number]): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isChartableValue(value: QueryResult["rows"][number][number]): boolean {
  return toChartNumber(value) !== null;
}

export function chartableColumnIndexes(result: QueryResult): number[] {
  return result.columns.map((_, index) => index).filter((index) => result.rows.some((row) => isChartableValue(row[index])));
}

export function axisColumnLabel(columns: string[], index: number): string {
  const name = columns[index] ?? `#${index + 1}`;
  if (columns.filter((column) => column === name).length <= 1) return name;
  return `${name} #${index + 1}`;
}
