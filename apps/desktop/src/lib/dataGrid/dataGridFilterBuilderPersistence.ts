import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import { dataGridColumnNameKey, dataGridSqlTextReferencesAnyColumn, removeDroppedColumnsFromStructuredWhere } from "@/lib/dataGrid/dataGridDropColumn";

export type DataGridCachedServerColumnFilter = {
  condition: string;
  keys: string[];
  labels: string[];
};

export type DataGridStructuredFilterCacheState = {
  scopeKey: string;
  manualWhereInput: string;
  rules: DataGridStructuredFilterRule[];
  groups?: {
    active: number;
    inactive: { number: number; rules: DataGridStructuredFilterRule[] }[];
  };
  appliedRules?: DataGridStructuredFilterRule[];
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
  "ilike",
  "not-ilike",
  "begins-with",
  "ends-with",
  "not-begins-with",
  "not-ends-with",
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

function sanitizeRules(rules: unknown[]): DataGridStructuredFilterRule[] {
  return rules.map(sanitizeRule).filter((rule): rule is DataGridStructuredFilterRule => !!rule);
}

function sanitizeGroups(value: unknown): DataGridStructuredFilterCacheState["groups"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { active, inactive } = value as Partial<NonNullable<DataGridStructuredFilterCacheState["groups"]>>;
  if (typeof active !== "number" || !Number.isSafeInteger(active) || active < 1 || !Array.isArray(inactive)) return undefined;
  const numbers = new Set([active]);
  const groups: NonNullable<DataGridStructuredFilterCacheState["groups"]>["inactive"] = [];
  for (const group of inactive) {
    if (!group || !Number.isSafeInteger(group.number) || group.number < 1 || numbers.has(group.number) || !Array.isArray(group.rules)) continue;
    numbers.add(group.number);
    groups.push({ number: group.number, rules: sanitizeRules(group.rules) });
  }
  return { active, inactive: groups };
}

function hasNamedFilterRules(state: DataGridStructuredFilterCacheState): boolean {
  return state.rules.some((rule) => rule.columnName) || !!state.groups?.inactive.some(({ rules }) => rules.some((rule) => rule.columnName));
}

function sanitizeState(value: unknown): DataGridStructuredFilterCacheState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Partial<DataGridStructuredFilterCacheState>;
  if (typeof state.scopeKey !== "string" || typeof state.manualWhereInput !== "string" || typeof state.appliedWhereInput !== "string") return undefined;
  if (!Array.isArray(state.rules)) return undefined;
  const groups = sanitizeGroups(state.groups);
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
    rules: sanitizeRules(state.rules),
    ...(groups ? { groups } : {}),
    ...(Array.isArray(state.appliedRules) ? { appliedRules: sanitizeRules(state.appliedRules) } : {}),
    appliedWhereInput: state.appliedWhereInput,
    serverColumnFilters,
  };
}

function cloneState(state: DataGridStructuredFilterCacheState): DataGridStructuredFilterCacheState {
  return {
    ...state,
    rules: cloneDataGridStructuredFilterRules(state.rules),
    ...(state.groups ? { groups: { active: state.groups.active, inactive: state.groups.inactive.map(({ number, rules }) => ({ number, rules: cloneDataGridStructuredFilterRules(rules) })) } } : {}),
    ...(state.appliedRules ? { appliedRules: cloneDataGridStructuredFilterRules(state.appliedRules) } : {}),
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

export function copyDataGridStructuredFilterStatesForTab(sourceTabId: string, targetTabId: string) {
  if (sourceTabId === targetTabId) return;
  ensureHydrated();
  const entries = [...structuredFilterStateCache.entries()].filter(([key]) => key === sourceTabId || key.startsWith(`${sourceTabId}-`));
  for (const [key, state] of entries) {
    saveDataGridStructuredFilterState(`${targetTabId}${key.slice(sourceTabId.length)}`, state);
  }
}

export function clearDataGridStructuredFilterStatesForTab(tabId: string) {
  ensureHydrated();
  structuredFilterStateCache.delete(tabId);
  for (const cacheKey of structuredFilterStateCache.keys()) {
    if (cacheKey.startsWith(`${tabId}-`)) structuredFilterStateCache.delete(cacheKey);
  }
  persistToStorage();
}

type AppliedStructuredFilter = Pick<DataGridStructuredFilterCacheState, "appliedRules" | "appliedWhereInput">;

export async function removeDataGridAppliedFilterColumns(state: AppliedStructuredFilter, droppedColumns: readonly string[], caseSensitive: boolean, buildWhere: (rules: DataGridStructuredFilterRule[]) => Promise<string>, dialectId?: string): Promise<AppliedStructuredFilter> {
  const { appliedRules, appliedWhereInput } = state;
  if (!appliedRules) {
    // Old caches store the last applied SQL but only the current draft rules.
    // Reading or resaving a group cannot recover the original rule values.
    return { appliedWhereInput: removeDroppedColumnsFromStructuredWhere(appliedWhereInput, droppedColumns, caseSensitive, dialectId) };
  }
  const dropped = new Set(droppedColumns.map((name) => dataGridColumnNameKey(name, caseSensitive)));
  const remaining = appliedRules.filter((rule) => !dropped.has(dataGridColumnNameKey(rule.columnName, caseSensitive)));
  if (remaining.length === appliedRules.length) return { appliedRules, appliedWhereInput };
  try {
    return { appliedRules: remaining, appliedWhereInput: await buildWhere(cloneDataGridStructuredFilterRules(remaining)) };
  } catch {
    // The DDL has already succeeded. Preserve usable predicates if rebuilding fails.
    return { appliedRules: remaining, appliedWhereInput: removeDroppedColumnsFromStructuredWhere(appliedWhereInput, droppedColumns, caseSensitive, dialectId) };
  }
}

/** Migrate a table tab's filters before its metadata and refresh SQL change. */
export async function removeDataGridStructuredFilterColumnsForTab(
  tabId: string,
  columns: readonly string[],
  droppedColumns: readonly string[],
  caseSensitive: boolean,
  buildWhere: (rules: DataGridStructuredFilterRule[]) => Promise<string>,
  dialectId?: string,
): Promise<DataGridStructuredFilterCacheState | undefined> {
  ensureHydrated();
  const state = structuredFilterStateCache.get(tabId);
  if (!state || droppedColumns.length === 0) return undefined;
  const key = (name: string) => dataGridColumnNameKey(name, caseSensitive);
  const dropped = new Set(droppedColumns.map(key));
  const remainingColumns = columns.filter((name) => !dropped.has(key(name)));
  const keepRules = (rules: DataGridStructuredFilterRule[]) => rules.filter((rule) => !dropped.has(key(rule.columnName)));
  const rules = keepRules(state.rules);
  const groups = state.groups && { active: state.groups.active, inactive: state.groups.inactive.map((group) => ({ ...group, rules: keepRules(group.rules) })) };
  const manualWhereInput = dataGridSqlTextReferencesAnyColumn(state.manualWhereInput, droppedColumns, caseSensitive) ? "" : state.manualWhereInput;
  const serverColumnFilters: Record<number, DataGridCachedServerColumnFilter> = {};
  for (const [indexText, filter] of Object.entries(state.serverColumnFilters)) {
    const column = columns[Number(indexText)];
    if (!column || dropped.has(key(column)) || dataGridSqlTextReferencesAnyColumn(filter.condition, droppedColumns, caseSensitive)) continue;
    serverColumnFilters[remainingColumns.indexOf(column)] = filter;
  }
  const applied = await removeDataGridAppliedFilterColumns(state, droppedColumns, caseSensitive, buildWhere, dialectId);
  // The last scope component is the column list; preserve the tab's own schema
  // and connection components instead of reconstructing them from another pane.
  const scopeParts = state.scopeKey.split("\u0001");
  scopeParts[scopeParts.length - 1] = remainingColumns.join("\0");
  const next = {
    ...state,
    scopeKey: scopeParts.join("\u0001"),
    rules,
    ...(groups ? { groups } : {}),
    ...applied,
    manualWhereInput,
    serverColumnFilters,
  };
  structuredFilterStateCache.set(tabId, cloneState(next));
  persistToStorage();
  return next;
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
