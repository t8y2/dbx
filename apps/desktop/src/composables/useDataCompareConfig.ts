import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";

/**
 * Persisted "Compare Data" task configuration.
 *
 * Only the user's selection is stored (endpoints + the tables to compare +
 * per-table match columns). Derived data such as the available database /
 * schema / table lists, compare results and sync plans are intentionally not
 * persisted: they are re-loaded from the live connection when a config is
 * applied, so a stale config can never resurrect a deleted table.
 */
export interface DataCompareConfig {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  selectedSourceTables: string[];
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  targetTable: string;
  /** Preview row limit, stored alongside the selection so re-running reproduces the same view. */
  detailPreviewLimit: string;
  /** Explicit match columns per source table; absent entry means "use the primary key". */
  keyColumnsByTable: Record<string, string[]>;
}

export interface DataCompareConfigSnapshot {
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  selectedSourceTables: string[];
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  targetTable: string;
  detailPreviewLimit: string;
  keyColumnsByTable: Record<string, string[]>;
}

const STORAGE_KEY = "dbx-data-compare-configs";
const MAX_CONFIGS = 50;

const configs = ref<DataCompareConfig[]>(loadConfigsFromStorage());
const activeConfigId = ref("");

function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function sanitizeKeyColumns(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [table, columns] of Object.entries(value as Record<string, unknown>)) {
    if (typeof table !== "string" || !table) continue;
    // Keep an explicitly empty array: it means "the user cleared the match
    // columns" and must not silently fall back to the primary key.
    if (Array.isArray(columns)) result[table] = sanitizeStringArray(columns);
  }
  return result;
}

function sanitizeConfig(raw: unknown): DataCompareConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" && item.id ? item.id : uuid();
  const name = typeof item.name === "string" && item.name.trim() ? item.name : "";
  if (!name) return undefined;
  const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
  const updatedAt = typeof item.updatedAt === "number" ? item.updatedAt : createdAt;
  return {
    id,
    name,
    createdAt,
    updatedAt,
    sourceConnectionId: typeof item.sourceConnectionId === "string" ? item.sourceConnectionId : "",
    sourceDatabase: typeof item.sourceDatabase === "string" ? item.sourceDatabase : "",
    sourceSchema: typeof item.sourceSchema === "string" ? item.sourceSchema : "",
    selectedSourceTables: sanitizeStringArray(item.selectedSourceTables),
    targetConnectionId: typeof item.targetConnectionId === "string" ? item.targetConnectionId : "",
    targetDatabase: typeof item.targetDatabase === "string" ? item.targetDatabase : "",
    targetSchema: typeof item.targetSchema === "string" ? item.targetSchema : "",
    targetTable: typeof item.targetTable === "string" ? item.targetTable : "",
    detailPreviewLimit: typeof item.detailPreviewLimit === "string" ? item.detailPreviewLimit : "",
    keyColumnsByTable: sanitizeKeyColumns(item.keyColumnsByTable),
  };
}

function loadConfigsFromStorage(): DataCompareConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeConfig).filter((config): config is DataCompareConfig => Boolean(config));
  } catch {
    return [];
  }
}

function saveConfigsToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs.value));
  } catch {
    // Quota/private-mode failures must never break the compare dialog; the
    // in-memory configs keep working for the current session.
  }
}

export function useDataCompareConfig() {
  const activeConfig = computed(() => configs.value.find((config) => config.id === activeConfigId.value) ?? null);

  function uniqueName(base: string, excludeId = ""): string {
    const trimmed = base.trim() || "Config";
    if (!configs.value.some((config) => config.name === trimmed && config.id !== excludeId)) return trimmed;
    let counter = 1;
    let candidate = `${trimmed} (${counter})`;
    while (configs.value.some((config) => config.name === candidate && config.id !== excludeId)) {
      counter++;
      candidate = `${trimmed} (${counter})`;
    }
    return candidate;
  }

  function createConfig(name: string, snapshot: DataCompareConfigSnapshot): DataCompareConfig {
    const now = Date.now();
    const config: DataCompareConfig = {
      ...snapshot,
      selectedSourceTables: [...snapshot.selectedSourceTables],
      keyColumnsByTable: sanitizeKeyColumns(snapshot.keyColumnsByTable),
      id: uuid(),
      name: uniqueName(name),
      createdAt: now,
      updatedAt: now,
    };
    configs.value = [config, ...configs.value].slice(0, MAX_CONFIGS);
    activeConfigId.value = config.id;
    saveConfigsToStorage();
    return config;
  }

  function updateConfig(id: string, patch: Partial<DataCompareConfigSnapshot>) {
    const index = configs.value.findIndex((config) => config.id === id);
    if (index === -1) return;
    const next: DataCompareConfig = {
      ...configs.value[index]!,
      ...patch,
      ...(patch.selectedSourceTables ? { selectedSourceTables: [...patch.selectedSourceTables] } : {}),
      ...(patch.keyColumnsByTable ? { keyColumnsByTable: sanitizeKeyColumns(patch.keyColumnsByTable) } : {}),
      updatedAt: Date.now(),
    };
    configs.value = configs.value.map((config, position) => (position === index ? next : config));
    saveConfigsToStorage();
  }

  function renameConfig(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const index = configs.value.findIndex((config) => config.id === id);
    if (index === -1) return;
    configs.value = configs.value.map((config) => (config.id === id ? { ...config, name: uniqueName(trimmed, id), updatedAt: Date.now() } : config));
    saveConfigsToStorage();
  }

  function deleteConfig(id: string) {
    configs.value = configs.value.filter((config) => config.id !== id);
    if (activeConfigId.value === id) activeConfigId.value = "";
    saveConfigsToStorage();
  }

  function duplicateConfig(id: string): DataCompareConfig | undefined {
    const source = configs.value.find((config) => config.id === id);
    if (!source) return undefined;
    const now = Date.now();
    const copy: DataCompareConfig = {
      ...source,
      id: uuid(),
      name: uniqueName(source.name),
      createdAt: now,
      updatedAt: now,
      selectedSourceTables: [...source.selectedSourceTables],
      keyColumnsByTable: sanitizeKeyColumns(source.keyColumnsByTable),
    };
    configs.value = [copy, ...configs.value].slice(0, MAX_CONFIGS);
    activeConfigId.value = copy.id;
    saveConfigsToStorage();
    return copy;
  }

  function clearActiveConfig() {
    activeConfigId.value = "";
  }

  watch(configs, saveConfigsToStorage, { deep: true });

  return {
    configs: computed(() => configs.value),
    activeConfigId,
    activeConfig,
    createConfig,
    updateConfig,
    renameConfig,
    deleteConfig,
    duplicateConfig,
    clearActiveConfig,
  };
}
