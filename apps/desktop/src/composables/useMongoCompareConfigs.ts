import { computed, ref } from "vue";
import { uuid } from "@/lib/common/utils";
import type { MongoCompareEndpoint } from "@/lib/mongo/mongoCompareRuntime";
import type { MongoCollectionPair } from "@/lib/mongo/mongoCompareBatch";

export interface MongoCompareConfigSnapshot {
  source: MongoCompareEndpoint;
  target: MongoCompareEndpoint;
  matchFields: string;
  ignoredFields: string;
  limit: number;
  numericTypesEqual: boolean;
  batchMode: boolean;
  pairs: MongoCollectionPair[];
}
export interface MongoCompareConfig extends MongoCompareConfigSnapshot {
  id: string;
  name: string;
  updatedAt: number;
}
export const MONGO_COMPARE_CONFIG_KEY = "dbx-mongo-compare-configs-v1";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function endpoint(value: unknown): MongoCompareEndpoint {
  const item = record(value);
  return { connectionId: text(item.connectionId), database: text(item.database), collection: text(item.collection), filter: text(item.filter, "{}") };
}
// Explicit allowlist: no result documents, write plans, passwords, or connection URIs.
export function mongoCompareConfigSnapshot(raw: unknown): MongoCompareConfigSnapshot {
  const item = record(raw);
  return {
    source: endpoint(item.source),
    target: endpoint(item.target),
    matchFields: text(item.matchFields, "_id"),
    ignoredFields: text(item.ignoredFields),
    limit: Number.isInteger(item.limit) && Number(item.limit) >= 1 && Number(item.limit) <= 100_000 ? Number(item.limit) : 10_000,
    numericTypesEqual: item.numericTypesEqual === true,
    batchMode: item.batchMode === true,
    pairs: (Array.isArray(item.pairs) ? item.pairs : [])
      .map((rawPair) => {
        const pair = record(rawPair);
        return { source: text(pair.source), target: text(pair.target), enabled: pair.enabled !== false, matchFields: text(pair.matchFields) };
      })
      .slice(0, 100),
  };
}

export function useMongoCompareConfigs() {
  const configs = ref<MongoCompareConfig[]>([]);
  const activeId = ref("");
  const storageError = ref(false);
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MONGO_COMPARE_CONFIG_KEY) ?? "[]");
    if (Array.isArray(parsed)) {
      const ids = new Set<string>();
      configs.value = parsed
        .flatMap((raw) => {
          const item = record(raw);
          const id = text(item.id);
          const name = text(item.name).trim();
          if (!id || !name || ids.has(id)) return [];
          ids.add(id);
          return [{ ...mongoCompareConfigSnapshot(item), id, name, updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0 }];
        })
        .slice(0, 50);
    }
  } catch {
    storageError.value = true;
  }

  function persist(next: MongoCompareConfig[]): boolean {
    try {
      localStorage.setItem(MONGO_COMPARE_CONFIG_KEY, JSON.stringify(next));
      configs.value = next;
      storageError.value = false;
      return true;
    } catch {
      storageError.value = true;
      return false;
    }
  }
  function save(name: string, snapshot: MongoCompareConfigSnapshot, asNew = false): boolean {
    if (!name.trim()) return false;
    const id = !asNew && configs.value.some((config) => config.id === activeId.value) ? activeId.value : uuid();
    if (!configs.value.some((config) => config.id === id) && configs.value.length >= 50) throw new Error("configLimit");
    const baseName = name.trim();
    let uniqueName = baseName;
    let suffix = 1;
    while (configs.value.some((config) => config.id !== id && config.name === uniqueName)) uniqueName = `${baseName} (${suffix++})`;
    const config = { ...mongoCompareConfigSnapshot(snapshot), id, name: uniqueName, updatedAt: Date.now() };
    if (!persist([config, ...configs.value.filter((item) => item.id !== id)])) return false;
    activeId.value = id;
    return true;
  }
  function remove(): boolean {
    if (!persist(configs.value.filter((item) => item.id !== activeId.value))) return false;
    activeId.value = "";
    return true;
  }
  return { configs: computed(() => configs.value), activeId, storageError, save, remove };
}
