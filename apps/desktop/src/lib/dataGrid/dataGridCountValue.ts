import type { CellValue } from "@/lib/dataGrid/cellValue";

export function sumGridCountValues(row: readonly CellValue[] | undefined): number | undefined {
  let total: number | undefined;
  for (const value of row ?? []) {
    if (typeof value === "number" && Number.isFinite(value)) total = (total ?? 0) + value;
    else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) total = (total ?? 0) + Number(value);
  }
  return total;
}
