export type RowStatus = "clean" | "edited" | "new" | "deleted" | "draft";
export type RowStatusFilter = "all" | "changed" | "edited" | "new" | "deleted";

export function matchesRowStatusFilter(status: RowStatus, filter: RowStatusFilter): boolean {
  if (status === "draft") return filter === "all";
  if (filter === "all") return true;
  if (filter === "changed") return status !== "clean";
  return status === filter;
}

export function rowStatusFilterAfterAddingRow(filter: RowStatusFilter): RowStatusFilter {
  return matchesRowStatusFilter("new", filter) ? filter : "all";
}

export function shouldShowQuickEntryDraftRow(options: { editable: boolean; hasInsertTarget: boolean; quickEntryEnabled: boolean; rowStatusFilter: RowStatusFilter; hasPendingChanges: boolean }): boolean {
  return options.editable && options.hasInsertTarget && options.quickEntryEnabled && !options.hasPendingChanges && matchesRowStatusFilter("draft", options.rowStatusFilter);
}

export function canDeleteGridRowItem(options: { editable: boolean; isDraft: boolean; isDeleted: boolean; isNew: boolean; canEditExistingRows: boolean; isSavingNewRow: boolean }): boolean {
  return options.editable && !options.isDraft && !options.isDeleted && !options.isSavingNewRow && (options.isNew || options.canEditExistingRows);
}

export function canEditGridCellDetail(options: { canEditCell: boolean; isDraft: boolean }): boolean {
  return options.canEditCell && !options.isDraft;
}

export function canApplyGridSelectionValue(options: { isDraft: boolean; allowDraft?: boolean }): boolean {
  return !options.isDraft || options.allowDraft === true;
}
