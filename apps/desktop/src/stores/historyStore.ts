import { defineStore } from "pinia";
import { uuid } from "@/lib/common/utils";
import { ref } from "vue";
import * as api from "@/lib/backend/api";
import type { HistoryConnectionOption, HistoryCursor, HistoryEntry, HistorySearchRequest } from "@/lib/backend/api";

const DEFAULT_HISTORY_SEARCH: HistorySearchRequest = {
  search_text: "",
  connections: [],
  databases: [],
  limit: 100,
};

function copyRequest(request: HistorySearchRequest): HistorySearchRequest {
  return {
    ...request,
    connections: request.connections.map((connection) => ({ ...connection })),
    databases: request.databases.map((database) => ({ ...database })),
    cursor: request.cursor ? { ...request.cursor } : undefined,
  };
}

export const useHistoryStore = defineStore("history", () => {
  const entries = ref<HistoryEntry[]>([]);
  const connectionOptions = ref<HistoryConnectionOption[]>([]);
  const loading = ref(false);
  const loadingMore = ref(false);
  const total = ref(0);
  const nextCursor = ref<HistoryCursor | null>(null);
  const error = ref("");
  const activeRequest = ref<HistorySearchRequest>(copyRequest(DEFAULT_HISTORY_SEARCH));
  // Ignore stale responses when filters change faster than the backend can respond.
  let requestSerial = 0;
  let mutationGeneration = 0;
  let destructiveMutations = 0;
  let historyPanelActive = false;
  let optionsRequestSerial = 0;
  let latestRequestedSearch = copyRequest(DEFAULT_HISTORY_SEARCH);

  function invalidateConnectionOptionRequests() {
    optionsRequestSerial += 1;
  }

  function setHistoryPanelActive(active: boolean) {
    historyPanelActive = active;
    if (active) return;
    requestSerial += 1;
    invalidateConnectionOptionRequests();
    loading.value = false;
    loadingMore.value = false;
  }

  function beginDestructiveMutation() {
    requestSerial += 1;
    mutationGeneration += 1;
    destructiveMutations += 1;
    invalidateConnectionOptionRequests();
    loading.value = false;
    loadingMore.value = false;
  }

  function endDestructiveMutation() {
    destructiveMutations = Math.max(0, destructiveMutations - 1);
    // Invalidate searches started while the backend mutation was still pending.
    mutationGeneration += 1;
    requestSerial += 1;
    loading.value = false;
    loadingMore.value = false;
  }

  async function search(request: HistorySearchRequest, append = false) {
    const serial = ++requestSerial;
    const generation = mutationGeneration;
    const baseRequest = copyRequest({ ...request, cursor: undefined });
    if (!append) latestRequestedSearch = copyRequest(baseRequest);
    const actualRequest = copyRequest({
      ...baseRequest,
      cursor: append ? (nextCursor.value ?? undefined) : undefined,
    });
    if (append) loadingMore.value = true;
    else loading.value = true;
    error.value = "";
    try {
      const result = await api.searchHistory(actualRequest);
      if (serial !== requestSerial || generation !== mutationGeneration || destructiveMutations > 0) return;
      activeRequest.value = baseRequest;
      if (append) {
        // A new entry may shift page boundaries while loading; deduplicate before appending.
        const knownIds = new Set(entries.value.map((entry) => entry.id));
        entries.value.push(...result.entries.filter((entry) => !knownIds.has(entry.id)));
      } else {
        entries.value = result.entries;
      }
      total.value = result.total;
      nextCursor.value = result.next_cursor ?? null;
    } catch (searchError) {
      if (serial !== requestSerial || generation !== mutationGeneration || destructiveMutations > 0) return;
      error.value = searchError instanceof Error ? searchError.message : String(searchError);
      throw searchError;
    } finally {
      if (serial === requestSerial) {
        loading.value = false;
        loadingMore.value = false;
      }
    }
  }

  async function load() {
    await search(DEFAULT_HISTORY_SEARCH);
  }

  async function loadMore() {
    if (!nextCursor.value || loading.value || loadingMore.value) return;
    try {
      await search(activeRequest.value, true);
    } catch {
      // The error is already exposed through store.error; prevent an unhandled click promise.
    }
  }

  async function loadConnectionOptions() {
    const serial = ++optionsRequestSerial;
    try {
      const options = await api.loadHistoryConnectionOptions();
      if (serial !== optionsRequestSerial) return;
      connectionOptions.value = options;
    } catch (loadError) {
      if (serial !== optionsRequestSerial) return;
      throw loadError;
    }
  }

  function addConnectionOption(entry: HistoryEntry) {
    const option = connectionOptions.value.find((candidate) => (entry.connection_id ? candidate.connection_id === entry.connection_id : !candidate.connection_id && candidate.connection_name === entry.connection_name));
    if (option) {
      if (entry.database && !option.databases.includes(entry.database)) option.databases.push(entry.database);
      return;
    }
    connectionOptions.value.unshift({
      connection_id: entry.connection_id ?? "",
      connection_name: entry.connection_name,
      databases: entry.database ? [entry.database] : [],
    });
  }

  async function add(entry: Omit<HistoryEntry, "id" | "executed_at">) {
    const full: HistoryEntry = {
      ...entry,
      id: uuid(),
      executed_at: new Date().toISOString(),
    };
    await api.saveHistory(full);
    invalidateConnectionOptionRequests();
    addConnectionOption(full);
    if (historyPanelActive) {
      try {
        // Re-query SQLite so eviction, totals, cursors, and text matching stay authoritative.
        await search(latestRequestedSearch);
      } catch {
        // The history panel exposes refresh failures without failing the completed query execution.
      }
    }
  }

  async function remove(id: string) {
    beginDestructiveMutation();
    try {
      await api.deleteHistoryEntry(id);
    } finally {
      endDestructiveMutation();
    }
    const wasVisible = entries.value.some((entry) => entry.id === id);
    entries.value = entries.value.filter((entry) => entry.id !== id);
    if (wasVisible) total.value = Math.max(0, total.value - 1);
    void loadConnectionOptions().catch(() => {});
  }

  async function clear() {
    beginDestructiveMutation();
    try {
      await api.clearHistory();
    } finally {
      endDestructiveMutation();
    }
    entries.value = [];
    connectionOptions.value = [];
    total.value = 0;
    nextCursor.value = null;
  }

  return {
    entries,
    connectionOptions,
    loading,
    loadingMore,
    total,
    nextCursor,
    error,
    activeRequest,
    search,
    load,
    loadMore,
    loadConnectionOptions,
    setHistoryPanelActive,
    add,
    remove,
    clear,
  };
});
