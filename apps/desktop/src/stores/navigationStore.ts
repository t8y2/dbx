import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { createGlobalNavigationHistory, moveGlobalNavigation, recordGlobalNavigation } from "@/lib/navigation/globalNavigationHistory";
import type { GlobalNavigationEntry } from "@/lib/navigation/navigationEntry";

export const useNavigationStore = defineStore("navigation", () => {
  const history = ref(createGlobalNavigationHistory());
  const restoring = ref(false);
  let restoreSerial = 0;

  const entries = computed(() => history.value.entries);
  const currentIndex = computed(() => history.value.index);
  const canGoBack = computed(() => history.value.index > 0);
  const canGoForward = computed(() => history.value.index >= 0 && history.value.index < history.value.entries.length - 1);

  function record(entry: GlobalNavigationEntry): void {
    if (restoring.value) return;
    history.value = recordGlobalNavigation(history.value, entry);
  }

  function beginRestore(): number {
    restoring.value = true;
    return ++restoreSerial;
  }

  function isCurrentRestore(serial: number): boolean {
    return serial === restoreSerial;
  }

  function endRestore(serial: number): void {
    if (serial === restoreSerial) restoring.value = false;
  }

  function move(direction: -1 | 1, isValid: (entry: GlobalNavigationEntry) => boolean): GlobalNavigationEntry | null {
    const result = moveGlobalNavigation(history.value, direction, isValid);
    if (!result) return null;
    history.value = result.history;
    return result.entry;
  }

  function snapshot() {
    return { entries: [...history.value.entries], index: history.value.index };
  }

  function restoreSnapshot(snapshotValue: { entries: GlobalNavigationEntry[]; index: number }): void {
    history.value = { entries: [...snapshotValue.entries], index: snapshotValue.index };
  }

  function clear(): void {
    history.value = createGlobalNavigationHistory();
  }

  return { entries, currentIndex, canGoBack, canGoForward, restoring, record, beginRestore, isCurrentRestore, endRestore, move, snapshot, restoreSnapshot, clear };
});
