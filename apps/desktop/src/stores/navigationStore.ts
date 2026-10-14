import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { createGlobalNavigationHistory, moveGlobalNavigation, recordGlobalNavigation } from "@/lib/navigation/globalNavigationHistory";
import type { GlobalNavigationEntry } from "@/lib/navigation/navigationEntry";

export const useNavigationStore = defineStore("navigation", () => {
  const history = ref(createGlobalNavigationHistory());
  const restoring = ref(false);
  let restoreSerial = 0;
  let expectedEntryId: string | undefined;
  let rollbackHistory: ReturnType<typeof snapshot> | undefined;

  const entries = computed(() => history.value.entries);
  const currentIndex = computed(() => history.value.index);
  const canGoBack = computed(() => history.value.index > 0);
  const canGoForward = computed(() => history.value.index >= 0 && history.value.index < history.value.entries.length - 1);

  function record(entry: GlobalNavigationEntry | null): void {
    if (restoring.value) {
      if (entry?.id === expectedEntryId) return;
      // A user navigation supersedes the pending restore. Before a target has
      // opened, undo the speculative history move before recording that visit.
      if (rollbackHistory) restoreSnapshot(rollbackHistory);
      endRestore(restoreSerial);
      ++restoreSerial;
    }
    if (entry) history.value = recordGlobalNavigation(history.value, entry);
  }

  function beginRestore(entry: GlobalNavigationEntry, previousHistory: ReturnType<typeof snapshot>): number {
    restoring.value = true;
    expectedEntryId = entry.id;
    rollbackHistory = previousHistory;
    return ++restoreSerial;
  }

  function acceptRestore(serial: number, entry: GlobalNavigationEntry): boolean {
    if (!isCurrentRestore(serial)) return false;
    expectedEntryId = entry.id;
    rollbackHistory = undefined;
    replaceCurrent(entry);
    return true;
  }

  function isCurrentRestore(serial: number): boolean {
    return restoring.value && serial === restoreSerial;
  }

  function endRestore(serial: number): void {
    if (serial !== restoreSerial) return;
    restoring.value = false;
    expectedEntryId = undefined;
    rollbackHistory = undefined;
  }

  function move(direction: -1 | 1, isValid: (entry: GlobalNavigationEntry) => boolean): GlobalNavigationEntry | null {
    const result = moveGlobalNavigation(history.value, direction, isValid);
    if (!result) return null;
    history.value = result.history;
    return result.entry;
  }

  function peek(direction: -1 | 1, isValid: (entry: GlobalNavigationEntry) => boolean): GlobalNavigationEntry | null {
    return moveGlobalNavigation(history.value, direction, isValid)?.entry ?? null;
  }

  function snapshot() {
    return { entries: [...history.value.entries], index: history.value.index };
  }

  function restoreSnapshot(snapshotValue: { entries: GlobalNavigationEntry[]; index: number }): void {
    history.value = { entries: [...snapshotValue.entries], index: snapshotValue.index };
  }

  function replaceCurrent(entry: GlobalNavigationEntry): void {
    if (history.value.index < 0) return;
    const entries = [...history.value.entries];
    entries[history.value.index] = entry;
    history.value = { entries, index: history.value.index };
  }

  function clear(): void {
    endRestore(restoreSerial);
    ++restoreSerial;
    history.value = createGlobalNavigationHistory();
  }

  return { entries, currentIndex, canGoBack, canGoForward, restoring, record, beginRestore, acceptRestore, isCurrentRestore, endRestore, move, peek, snapshot, restoreSnapshot, replaceCurrent, clear };
});
