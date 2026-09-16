import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";

export type DataGridCachedServerColumnFilter = {
  condition: string;
  keys: string[];
  labels: string[];
};

export type DataGridStructuredFilterCacheState = {
  scopeKey: string;
  manualWhereInput: string;
  rules: DataGridStructuredFilterRule[];
  appliedWhereInput: string;
  serverColumnFilters: Record<number, DataGridCachedServerColumnFilter>;
};

const STRUCTURED_FILTER_STATE_CACHE_MAX_ENTRIES = 128;
const STORAGE_KEY = "dbx-data-grid-structured-filters";
const STORAGE_VERSION = 1;
const FILTER_MODE_LIST = [
  "equals",
  "not-equals",
  "is-null",
  "is-not-null",
  "is-blank",
  "is-not-blank",
  "like",
  "not-like",
  "begins-with",
  "ends-with",
  "less-than",
  "less-than-or-equal",
  "greater-than",
  "greater-than-or-equal",
  "in",
  "not-in",
  "between",
  "not-between",
] as const satisfies readonly DataGridContextFilterMode[];
// Type-level guard: breaks compilation when DataGridContextFilterMode gains a member missing from FILTER_MODE_LIST.
type _MissingFilterModes = Exclude<DataGridContextFilterMode, (typeof FILTER_MODE_LIST)[number]>;
const FILTER_MODES: Set<DataGridContextFilterMode> & ([_MissingFilterModes] extends [never] ? unknown : never) = new Set<DataGridContextFilterMode>(FILTER_MODE_LIST);

const structuredFilterStateCache = new Map<string, DataGridStructuredFilterCacheState>();
let hydrated = false;

export function cloneDataGridStructuredFilterRules(rules: readonly DataGridStructuredFilterRule[]): DataGridStructuredFilterRule[] {
  return rules.map((rule) => ({ ...rule }));
}

function isFilterMode(value: unknown): value is DataGridContextFilterMode {
  return typeof value === "string" && FILTER_MODES.has(value as DataGridContextFilterMode);
}

function sanitizeRule(value: unknown): DataGridStructuredFilterRule | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rule = value as Partial<DataGridStructuredFilterRule>;
  if (typeof rule.id !== "string" || typeof rule.columnName !== "string") return undefined;
  if (!isFilterMode(rule.mode)) return undefined;
  if (typeof rule.rawValue !== "string" || typeof rule.rawEndValue !== "string") return undefined;
  if (rule.conjunction !== "AND" && rule.conjunction !== "OR") return undefined;
  return {
    id: rule.id,
    columnName: rule.columnName,
    mode: rule.mode,
    rawValue: rule.rawValue,
    rawEndValue: rule.rawEndValue,
    conjunction: rule.conjunction,
    ...(rule.disabled === true ? { disabled: true } : {}),
  };
}

function sanitizeServerColumnFilter(value: unknown): DataGridCachedServerColumnFilter | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const filter = value as Partial<DataGridCachedServerColumnFilter>;
  if (typeof filter.condition !== "string" || !Array.isArray(filter.keys) || !Array.isArray(filter.labels)) return undefined;
  const keys = filter.keys.filter((key): key is string => typeof key === "string");
  const labels = filter.labels.filter((label): label is string => typeof label === "string");
  if (keys.length !== filter.keys.length || labels.length !== filter.labels.length) return undefined;
  return { condition: filter.condition, keys, labels };
}

function hasNamedFilterRules(state: Pick<DataGridStructuredFilterCacheState, "rules">): boolean {
  return state.rules.some((rule) => rule.columnName);
}

function sanitizeState(value: unknown): DataGridStructuredFilterCacheState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Partial<DataGridStructuredFilterCacheState>;
  if (typeof state.scopeKey !== "string" || typeof state.manualWhereInput !== "string" || typeof state.appliedWhereInput !== "string") return undefined;
  if (!Array.isArray(state.rules)) return undefined;
  const rules = state.rules.map(sanitizeRule).filter((rule): rule is DataGridStructuredFilterRule => !!rule);
  const serverColumnFilters: Record<number, DataGridCachedServerColumnFilter> = {};
  if (state.serverColumnFilters && typeof state.serverColumnFilters === "object" && !Array.isArray(state.serverColumnFilters)) {
    for (const [key, filter] of Object.entries(state.serverColumnFilters)) {
      if (!/^\d+$/.test(key)) continue;
      const sanitized = sanitizeServerColumnFilter(filter);
      if (sanitized) serverColumnFilters[Number(key)] = sanitized;
    }
  }
  return {
    scopeKey: state.scopeKey,
    manualWhereInput: state.manualWhereInput,
    rules,
    appliedWhereInput: state.appliedWhereInput,
    serverColumnFilters,
  };
}

function cloneState(state: DataGridStructuredFilterCacheState): DataGridStructuredFilterCacheState {
  return {
    ...state,
    rules: cloneDataGridStructuredFilterRules(state.rules),
    serverColumnFilters: structuredClone(state.serverColumnFilters),
  };
}

function persistToStorage() {
  const entries = [...structuredFilterStateCache.entries()];
  if (entries.length === 0) {
    safeLocalStorageRemove(STORAGE_KEY);
    return;
  }
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, entries }));
}

function ensureHydrated() {
  if (hydrated) return;
  hydrated = true;
  const raw = safeLocalStorageGet(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.entries)) return;
    for (const entry of parsed.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
      const state = sanitizeState(entry[1]);
      if (!state) continue;
      structuredFilterStateCache.set(entry[0], state);
      if (structuredFilterStateCache.size >= STRUCTURED_FILTER_STATE_CACHE_MAX_ENTRIES) break;
    }
  } catch {
    structuredFilterStateCache.clear();
  }
}

export function loadDataGridStructuredFilterState(cacheKey: string, scopeKey: string): DataGridStructuredFilterCacheState | undefined {
  ensureHydrated();
  const cached = structuredFilterStateCache.get(cacheKey);
  if (!cached || cached.scopeKey !== scopeKey) return undefined;
  structuredFilterStateCache.delete(cacheKey);
  structuredFilterStateCache.set(cacheKey, cached);
  return cloneState(cached);
}

export function saveDataGridStructuredFilterState(cacheKey: string, state: DataGridStructuredFilterCacheState) {
  ensureHydrated();
  const existing = structuredFilterStateCache.get(cacheKey);
  // A scope miss hydrates the empty default builder while initialWhereInput still
  // holds the combined SQL. Do not let that write-through erase visual rules (#8831).
  if (existing && existing.scopeKey !== state.scopeKey && hasNamedFilterRules(existing) && !hasNamedFilterRules(state)) return;
  structuredFilterStateCache.delete(cacheKey);
  structuredFilterStateCache.set(cacheKey, cloneState(state));
  while (structuredFilterStateCache.size > STRUCTURED_FILTER_STATE_CACHE_MAX_ENTRIES) {
    const oldest = structuredFilterStateCache.keys().next().value;
    if (oldest === undefined) break;
    structuredFilterStateCache.delete(oldest);
  }
  persistToStorage();
}

export function clearDataGridStructuredFilterStatesForTab(tabId: string) {
  ensureHydrated();
  structuredFilterStateCache.delete(tabId);
  for (const cacheKey of structuredFilterStateCache.keys()) {
    if (cacheKey.startsWith(`${tabId}-`)) structuredFilterStateCache.delete(cacheKey);
  }
  persistToStorage();
}

export function clearDataGridStructuredFilterStates() {
  structuredFilterStateCache.clear();
  hydrated = true;
  persistToStorage();
}

/** Drop the in-memory cache without touching disk, as if the process restarted. */
export function dropDataGridStructuredFilterMemoryCache() {
  structuredFilterStateCache.clear();
  hydrated = false;
}
