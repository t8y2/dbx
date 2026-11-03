import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";

export type DataGridFilterModeOption = { value: DataGridContextFilterMode; labelKey: string };

const STORAGE_KEY = "dbx-data-grid-filter-mode-order-v1";

function readOrders(): Record<string, DataGridContextFilterMode[]> {
  try {
    const parsed = JSON.parse(safeLocalStorageGet(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => Array.isArray(value) && value.every((item) => typeof item === "string")) as [string, DataGridContextFilterMode[]][]);
  } catch {
    return {};
  }
}

export function orderDataGridFilterModeOptions(databaseType: string | undefined, options: readonly DataGridFilterModeOption[]): DataGridFilterModeOption[] {
  const order = readOrders()[databaseType || "unknown"] ?? [];
  const rank = new Map(order.map((value, index) => [value, index]));
  return [...options].sort((left, right) => (rank.get(left.value) ?? options.length) - (rank.get(right.value) ?? options.length));
}

export function saveDataGridFilterModeOrder(databaseType: string | undefined, values: readonly DataGridContextFilterMode[]): void {
  const key = databaseType || "unknown";
  const orders = readOrders();
  orders[key] = [...new Set(values)];
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(orders));
}

export function resetDataGridFilterModeOrder(databaseType: string | undefined): void {
  const orders = readOrders();
  delete orders[databaseType || "unknown"];
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(orders));
}
