export function shouldDeleteHistoryEntry(confirmDelete: () => boolean): boolean {
  return confirmDelete();
}

export function shouldClearHistory(entryCount: number, confirmClear: () => boolean): boolean {
  return entryCount > 0 && confirmClear();
}
