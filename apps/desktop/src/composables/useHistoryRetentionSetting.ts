import { computed, ref } from "vue";
import { loadHistoryRetentionLimit, saveHistoryRetentionLimit } from "@/lib/backend/api";

export const HISTORY_RETENTION_LIMITS = [200, 1000, 5000, 10000, 0] as const;
export const DEFAULT_HISTORY_RETENTION_LIMIT = 1000;

export function isHistoryRetentionLimit(value: unknown): value is number {
  return typeof value === "number" && HISTORY_RETENTION_LIMITS.some((limit) => limit === value);
}

/** A server-owned setting: browser localStorage cannot configure MCP retention. */
export function useHistoryRetentionSetting() {
  const draft = ref(DEFAULT_HISTORY_RETENTION_LIMIT);
  const persisted = ref(DEFAULT_HISTORY_RETENTION_LIMIT);
  const loaded = ref(false);
  const loading = ref(false);
  const saving = ref(false);
  const loadError = ref("");
  let generation = 0;
  const changed = computed(() => loaded.value && draft.value !== persisted.value);
  const invalid = computed(() => loaded.value && !isHistoryRetentionLimit(draft.value));

  async function load() {
    const request = ++generation;
    loaded.value = false;
    loading.value = true;
    loadError.value = "";
    try {
      const value = await loadHistoryRetentionLimit();
      if (!isHistoryRetentionLimit(value)) throw new Error("Invalid query history retention limit");
      if (request !== generation) return;
      draft.value = persisted.value = value;
      loaded.value = true;
    } catch (error) {
      if (request === generation) loadError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  async function save() {
    if (!changed.value || saving.value) return;
    if (invalid.value) throw new Error("Invalid query history retention limit");
    const value = draft.value;
    saving.value = true;
    try {
      await saveHistoryRetentionLimit(value);
      persisted.value = value;
    } finally {
      saving.value = false;
    }
  }

  function discard() {
    generation += 1;
    loading.value = false;
    draft.value = persisted.value;
  }

  function reset() {
    if (loaded.value) draft.value = DEFAULT_HISTORY_RETENTION_LIMIT;
  }

  return { draft, loaded, loading, saving, loadError, changed, invalid, load, save, discard, reset };
}
