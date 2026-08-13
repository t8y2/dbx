import type { DataGridTypeVisualKind } from "@/lib/dataGrid/dataGridColumnType";

export type DataGridCellTextRole = "muted" | "neutral" | "type";

export interface DataGridCellTextVisualState {
  colorizeTypes: boolean;
  typeKind: DataGridTypeVisualKind;
  isNull?: boolean;
  isDraft?: boolean;
  isEditing?: boolean;
  isControl?: boolean;
  isSelected?: boolean;
  isCurrentSearchMatch?: boolean;
  isSearchMatch?: boolean;
  isDirty?: boolean;
  isDeleted?: boolean;
}

const DATA_GRID_TYPE_VISUAL_CLASSES: Record<DataGridTypeVisualKind, string> = {
  integer: "data-grid-type-integer",
  numeric: "data-grid-type-numeric",
  string: "data-grid-type-string",
  boolean: "data-grid-type-boolean",
  temporal: "data-grid-type-temporal",
  structured: "data-grid-type-structured",
  identifier: "data-grid-type-identifier",
  binary: "data-grid-type-binary",
  spatial: "data-grid-type-spatial",
  unknown: "text-muted-foreground",
};

export function dataGridTypeVisualClass(kind: DataGridTypeVisualKind): string {
  return DATA_GRID_TYPE_VISUAL_CLASSES[kind];
}

/** Keep interaction and edit state more prominent than the optional type cue. */
export function resolveDataGridCellTextRole(state: DataGridCellTextVisualState): DataGridCellTextRole {
  if (state.isNull || state.isDraft) return "muted";
  if (!state.colorizeTypes || state.typeKind === "unknown" || state.isEditing || state.isControl || state.isSelected || state.isCurrentSearchMatch || state.isSearchMatch || state.isDirty || state.isDeleted) {
    return "neutral";
  }
  return "type";
}

export function dataGridCellTextClass(state: DataGridCellTextVisualState): string {
  const role = resolveDataGridCellTextRole(state);
  if (role === "muted") return "text-muted-foreground italic";
  if (role === "neutral") return "text-foreground";
  return dataGridTypeVisualClass(state.typeKind);
}
