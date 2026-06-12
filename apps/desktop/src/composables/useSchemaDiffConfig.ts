import { ref, computed, watch } from "vue";
import { uuid } from "@/lib/utils";
import type { SchemaDiffConfig, SchemaDiffCompareOptions } from "@/types/schemaDiff";
import { createEmptyConfig, getDefaultOptionsForDbType } from "@/types/schemaDiff";

const STORAGE_KEY = "dbx-schema-diff-configs";
const HISTORY_KEY = "dbx-schema-diff-history";
const MAX_HISTORY = 10;

const configs = ref<SchemaDiffConfig[]>(loadConfigsFromStorage());
const activeConfigId = ref<string>("");
const recentConfigs = ref<SchemaDiffConfig[]>(loadHistoryFromStorage());

function loadConfigsFromStorage(): SchemaDiffConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SchemaDiffConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadHistoryFromStorage(): SchemaDiffConfig[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SchemaDiffConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveConfigsToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs.value));
}

function saveHistoryToStorage() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(recentConfigs.value));
}

function createDefaultConfig(dbType?: string): SchemaDiffConfig {
  const id = uuid();
  const config = createEmptyConfig(id, "Default");
  if (dbType) {
    config.options = getDefaultOptionsForDbType(dbType);
  }
  return config;
}

export function useSchemaDiffConfig() {
  const activeConfig = computed(() => configs.value.find((c) => c.id === activeConfigId.value) ?? configs.value[0] ?? null);

  function ensureDefaultConfig(dbType?: string) {
    if (configs.value.length === 0) {
      const defaultConfig = createDefaultConfig(dbType);
      configs.value.push(defaultConfig);
      activeConfigId.value = defaultConfig.id;
      saveConfigsToStorage();
    } else if (!activeConfigId.value) {
      activeConfigId.value = configs.value[0].id;
    }
  }

  function createConfig(name: string, base?: SchemaDiffConfig, dbType?: string): SchemaDiffConfig {
    const id = uuid();
    const config = base ? { ...base, id, name, createdAt: Date.now(), updatedAt: Date.now() } : createEmptyConfig(id, name);
    if (dbType && !base) {
      config.options = getDefaultOptionsForDbType(dbType);
    }
    configs.value.push(config);
    activeConfigId.value = id;
    saveConfigsToStorage();
    return config;
  }

  function updateConfig(id: string, updates: Partial<Omit<SchemaDiffConfig, "id" | "createdAt">>) {
    const index = configs.value.findIndex((c) => c.id === id);
    if (index === -1) return;
    configs.value[index] = {
      ...configs.value[index],
      ...updates,
      updatedAt: Date.now(),
    };
    saveConfigsToStorage();
  }

  function renameConfig(id: string, name: string) {
    updateConfig(id, { name });
  }

  function deleteConfig(id: string) {
    configs.value = configs.value.filter((c) => c.id !== id);
    if (activeConfigId.value === id) {
      activeConfigId.value = configs.value[0]?.id ?? "";
    }
    saveConfigsToStorage();
  }

  function duplicateConfig(id: string) {
    const source = configs.value.find((c) => c.id === id);
    if (!source) return;
    let newName = `${source.name} (1)`;
    let counter = 1;
    while (configs.value.some((c) => c.name === newName)) {
      counter++;
      newName = `${source.name} (${counter})`;
    }
    createConfig(newName, source);
  }

  function exportConfigs(): string {
    return JSON.stringify(configs.value, null, 2);
  }

  function exportActiveConfig(): string {
    if (!activeConfig.value) return "";
    return JSON.stringify(activeConfig.value, null, 2);
  }

  function importConfigs(
    jsonText: string,
    mode: "merge" | "replace" = "merge",
  ): {
    imported: number;
    renamed: number;
  } {
    const parsed = JSON.parse(jsonText) as SchemaDiffConfig | SchemaDiffConfig[];
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let renamed = 0;

    if (mode === "replace") {
      configs.value = [];
    }

    for (const item of items) {
      let name = item.name;
      if (configs.value.some((c) => c.name === name && c.id !== item.id)) {
        let counter = 1;
        let candidate = `${name} (${counter})`;
        while (configs.value.some((c) => c.name === candidate)) {
          counter++;
          candidate = `${name} (${counter})`;
        }
        name = candidate;
        renamed++;
      }
      const newId = uuid();
      configs.value.push({
        ...item,
        id: newId,
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    saveConfigsToStorage();
    if (!activeConfigId.value && configs.value.length > 0) {
      activeConfigId.value = configs.value[0].id;
    }

    return { imported: items.length, renamed };
  }

  function updateActiveConfigOptions(options: SchemaDiffCompareOptions) {
    if (!activeConfig.value) return;
    updateConfig(activeConfig.value.id, { options: { ...options } });
  }

  function updateActiveConfigConnection(updates: Partial<SchemaDiffConfig>) {
    if (!activeConfig.value) return;
    const filtered: Partial<SchemaDiffConfig> = {};
    if (updates.sourceConnectionId !== undefined) filtered.sourceConnectionId = updates.sourceConnectionId;
    if (updates.sourceDatabase !== undefined) filtered.sourceDatabase = updates.sourceDatabase;
    if (updates.sourceSchema !== undefined) filtered.sourceSchema = updates.sourceSchema;
    if (updates.targetConnectionId !== undefined) filtered.targetConnectionId = updates.targetConnectionId;
    if (updates.targetDatabase !== undefined) filtered.targetDatabase = updates.targetDatabase;
    if (updates.targetSchema !== undefined) filtered.targetSchema = updates.targetSchema;
    updateConfig(activeConfig.value.id, filtered);
  }

  function saveToHistory(config: SchemaDiffConfig) {
    // Check if same config already exists (same connection/db/schema)
    const existingIndex = recentConfigs.value.findIndex(
      (c) => c.sourceConnectionId === config.sourceConnectionId && c.sourceDatabase === config.sourceDatabase && c.sourceSchema === config.sourceSchema && c.targetConnectionId === config.targetConnectionId && c.targetDatabase === config.targetDatabase && c.targetSchema === config.targetSchema,
    );

    if (existingIndex !== -1) {
      // Update existing entry
      recentConfigs.value[existingIndex] = {
        ...config,
        id: recentConfigs.value[existingIndex].id,
        updatedAt: Date.now(),
      };
      // Move to front
      const updated = recentConfigs.value.splice(existingIndex, 1)[0];
      recentConfigs.value.unshift(updated);
    } else {
      // Add new entry
      recentConfigs.value.unshift({
        ...config,
        id: uuid(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Keep only MAX_HISTORY items
    if (recentConfigs.value.length > MAX_HISTORY) {
      recentConfigs.value = recentConfigs.value.slice(0, MAX_HISTORY);
    }

    saveHistoryToStorage();
  }

  function loadFromHistory(configId: string) {
    const config = recentConfigs.value.find((c) => c.id === configId);
    if (!config) return null;
    return config;
  }

  function deleteFromHistory(configId: string) {
    recentConfigs.value = recentConfigs.value.filter((c) => c.id !== configId);
    saveHistoryToStorage();
  }

  watch(configs, saveConfigsToStorage, { deep: true });

  return {
    configs: computed(() => configs.value),
    activeConfigId,
    activeConfig,
    recentConfigs: computed(() => recentConfigs.value),
    ensureDefaultConfig,
    createConfig,
    updateConfig,
    renameConfig,
    deleteConfig,
    duplicateConfig,
    exportConfigs,
    exportActiveConfig,
    importConfigs,
    updateActiveConfigOptions,
    updateActiveConfigConnection,
    saveToHistory,
    loadFromHistory,
    deleteFromHistory,
  };
}
