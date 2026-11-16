import { reactive } from "vue";

export interface DataCompareSelection {
  all: boolean;
  exceptions: Set<number>;
}

// Rows are immutable. Only the default selection and its exceptions are reactive,
// so selecting an entire comparison never mutates thousands of row objects.
export function createDataCompareSelection(all: boolean): DataCompareSelection {
  return reactive({ all, exceptions: new Set<number>() });
}

export function isCompareRowSelected(selection: DataCompareSelection, index: number): boolean {
  return selection.all !== selection.exceptions.has(index);
}

export function setCompareSelection(selection: DataCompareSelection, all: boolean): void {
  selection.all = all;
  selection.exceptions = new Set();
}

export function toggleCompareSelection(selection: DataCompareSelection, index: number): void {
  if (selection.exceptions.has(index)) selection.exceptions.delete(index);
  else selection.exceptions.add(index);
}

export function countCompareSelection(selection: DataCompareSelection, total: number): number {
  return selection.all ? total - selection.exceptions.size : selection.exceptions.size;
}

export function selectedCompareRows<T>(rows: T[], selection: DataCompareSelection): T[] {
  if (!selection.exceptions.size) return selection.all ? rows : [];
  return rows.filter((_, index) => isCompareRowSelected(selection, index));
}
