import { defineStore } from "pinia";
import { ref } from "vue";
import * as api from "@/lib/api";
import type { HistoryEntry } from "@/lib/api";

export const useHistoryStore = defineStore("history", () => {
  const entries = ref<HistoryEntry[]>([]);
  const loading = ref(false);

  async function load() {
    loading.value = true;
    try {
      entries.value = await api.loadHistory(200, 0);
    } finally {
      loading.value = false;
    }
  }

  async function add(entry: Omit<HistoryEntry, "id" | "executed_at">) {
    const full: HistoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      executed_at: new Date().toISOString(),
    };
    await api.saveHistory(full);
    entries.value.unshift(full);
    if (entries.value.length > 200) entries.value.pop();
  }

  async function remove(id: string) {
    await api.deleteHistoryEntry(id);
    entries.value = entries.value.filter((e) => e.id !== id);
  }

  async function clear() {
    await api.clearHistory();
    entries.value = [];
  }

  return { entries, loading, load, add, remove, clear };
});
