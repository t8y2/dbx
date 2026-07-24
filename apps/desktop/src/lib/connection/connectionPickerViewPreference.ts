import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export type DbPickerView = "icon" | "list";

export const CONNECTION_PICKER_VIEW_STORAGE_KEY = "dbx-connection-picker-view";

export function normalizeConnectionPickerView(value: unknown): DbPickerView {
  return value === "list" ? "list" : "icon";
}

export function loadConnectionPickerView(): DbPickerView {
  return normalizeConnectionPickerView(safeLocalStorageGet(CONNECTION_PICKER_VIEW_STORAGE_KEY));
}

export function saveConnectionPickerView(view: DbPickerView) {
  safeLocalStorageSet(CONNECTION_PICKER_VIEW_STORAGE_KEY, view);
}
