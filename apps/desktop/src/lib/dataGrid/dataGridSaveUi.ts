import type { DatabaseType } from "@/types/database";

const NON_SQL_PREVIEW_DATABASE_TYPES: ReadonlySet<DatabaseType> = new Set<DatabaseType>(["mongodb", "elasticsearch"]);

export function dataGridPreviewLabelKey(databaseType?: DatabaseType): "toolbar.previewQuery" | "toolbar.previewSql" {
  return databaseType && NON_SQL_PREVIEW_DATABASE_TYPES.has(databaseType) ? "toolbar.previewQuery" : "toolbar.previewSql";
}

export interface DataGridSaveActionMode {
  labelKey: "grid.commit" | "grid.save";
  tooltipKey: "grid.transactionSaveHint" | "grid.nonTransactionalSaveHint";
  secondaryActionKey: "grid.rollback" | "grid.discard";
}

export function dataGridSaveActionMode(options: { pendingChangeCount: number; useTransaction: boolean }): DataGridSaveActionMode {
  return {
    labelKey: options.useTransaction ? "grid.commit" : "grid.save",
    tooltipKey: options.useTransaction ? "grid.transactionSaveHint" : "grid.nonTransactionalSaveHint",
    secondaryActionKey: options.useTransaction ? "grid.rollback" : "grid.discard",
  };
}

export interface DataGridSaveToolbarState {
  showActions: boolean;
  actionsDisabled: boolean;
}

export function dataGridSaveToolbarState(options: { editable: boolean; hasSaveTarget: boolean; hasPendingChanges: boolean; isSaving: boolean }): DataGridSaveToolbarState {
  const showActions = options.editable && options.hasSaveTarget;
  return {
    showActions,
    actionsDisabled: !showActions || !options.hasPendingChanges || options.isSaving,
  };
}
