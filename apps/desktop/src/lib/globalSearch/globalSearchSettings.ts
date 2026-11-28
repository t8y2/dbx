import { ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { getSqlFileFolderPaths } from "@/lib/sqlFile/sqlFileFolders";
import * as api from "@/lib/backend/api";

const ROOTS_STORAGE_KEY = "dbx-global-search-roots";
const EXTENSIONS_STORAGE_KEY = "dbx-global-search-extensions";
const MATCH_MODE_STORAGE_KEY = "dbx-global-search-match-mode";
const SHOW_QUICK_FILTERS_STORAGE_KEY = "dbx-global-search-show-quick-filters";
const SEARCH_ITEM_TYPES_STORAGE_KEY = "dbx-global-search-item-types";
export const DEFAULT_GLOBAL_SEARCH_EXTENSIONS = ["sql"];
export type GlobalSearchMatchMode = "precise" | "enhanced";
export const DEFAULT_GLOBAL_SEARCH_MATCH_MODE: GlobalSearchMatchMode = "precise";
export const DEFAULT_GLOBAL_SEARCH_SHOW_QUICK_FILTERS = true;
export const GLOBAL_SEARCH_ITEM_TYPES = ["connection", "database", "schema", "table", "view", "routine", "column", "file", "content", "command"] as const;
export type GlobalSearchItemType = "connection" | "database" | "schema" | "table" | "view" | "routine" | "column" | "file" | "content" | "command";
export type GlobalSearchItemTypes = Record<string, boolean>;
export const DEFAULT_GLOBAL_SEARCH_ITEM_TYPES: GlobalSearchItemTypes = Object.fromEntries(GLOBAL_SEARCH_ITEM_TYPES.map((type) => [type, true])) as GlobalSearchItemTypes;

/**
 * Shared reactive version counter — bumped whenever global-search settings change.
 * useQuickOpen watches this to know when to re-run the current search.
 */
export const globalSearchSettingsVersion = ref(0);
let globalSearchSettingsWriteQueue: Promise<void> = Promise.resolve();

/** Additional search root directories (on top of the configured SQL file folders). */
function normalizeRoots(roots: unknown): string[] {
  return Array.isArray(roots)
    ? [
        ...new Set(
          roots
            .filter((root): root is string => typeof root === "string")
            .map((root) => root.trim())
            .filter((root) => root.length > 0),
        ),
      ]
    : [];
}

function normalizeExtensions(extensions: unknown): string[] {
  if (!Array.isArray(extensions)) return [];
  return [
    ...new Set(
      extensions
        .filter((ext): ext is string => typeof ext === "string")
        .map((ext) => ext.trim().replace(/^\.+/, "").toLowerCase())
        .filter((ext) => ext.length > 0),
    ),
  ];
}

export function getGlobalSearchRoots(): string[] {
  try {
    const raw = safeLocalStorageGet(ROOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeRoots(parsed);
  } catch {
    return [];
  }
}

/** File extensions to search (normalized, without a leading dot). */
export function getGlobalSearchExtensions(): string[] {
  try {
    const raw = safeLocalStorageGet(EXTENSIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const normalized = normalizeExtensions(parsed);
        if (normalized.length > 0) return normalized;
      }
    }
  } catch {
    // fall through to default
  }
  return [...DEFAULT_GLOBAL_SEARCH_EXTENSIONS];
}

export function getGlobalSearchMatchMode(): GlobalSearchMatchMode {
  const raw = safeLocalStorageGet(MATCH_MODE_STORAGE_KEY);
  return raw === "enhanced" ? "enhanced" : DEFAULT_GLOBAL_SEARCH_MATCH_MODE;
}

export function getGlobalSearchShowQuickFilters(): boolean {
  const raw = safeLocalStorageGet(SHOW_QUICK_FILTERS_STORAGE_KEY);
  return raw == null ? DEFAULT_GLOBAL_SEARCH_SHOW_QUICK_FILTERS : raw !== "false";
}

export function getGlobalSearchItemTypes(): GlobalSearchItemTypes {
  try {
    const raw = safeLocalStorageGet(SEARCH_ITEM_TYPES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GLOBAL_SEARCH_ITEM_TYPES };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(GLOBAL_SEARCH_ITEM_TYPES.map((type) => [type, parsed[type] !== false])) as GlobalSearchItemTypes;
  } catch {
    return { ...DEFAULT_GLOBAL_SEARCH_ITEM_TYPES };
  }
}

function globalSearchSettingsPayload(): { roots: string[]; extensions: string[]; matchMode?: GlobalSearchMatchMode; showQuickFilters?: boolean; itemTypes?: GlobalSearchItemTypes } {
  const payload: { roots: string[]; extensions: string[]; matchMode?: GlobalSearchMatchMode; showQuickFilters?: boolean; itemTypes?: GlobalSearchItemTypes } = {
    roots: getGlobalSearchRoots(),
    extensions: getGlobalSearchExtensions(),
  };
  if (getGlobalSearchMatchMode() !== DEFAULT_GLOBAL_SEARCH_MATCH_MODE) payload.matchMode = getGlobalSearchMatchMode();
  if (getGlobalSearchShowQuickFilters() !== DEFAULT_GLOBAL_SEARCH_SHOW_QUICK_FILTERS) payload.showQuickFilters = getGlobalSearchShowQuickFilters();
  const itemTypes = getGlobalSearchItemTypes();
  if (GLOBAL_SEARCH_ITEM_TYPES.some((type) => itemTypes[type] !== DEFAULT_GLOBAL_SEARCH_ITEM_TYPES[type])) payload.itemTypes = itemTypes;
  return payload;
}

export function saveGlobalSearchRoots(roots: string[]): void {
  const normalized = normalizeRoots(roots);
  safeLocalStorageSet(ROOTS_STORAGE_KEY, JSON.stringify(normalized));
  globalSearchSettingsVersion.value++;
  void persistGlobalSearchSettings();
}

export function saveGlobalSearchExtensions(extensions: string[]): void {
  const normalized = normalizeExtensions(extensions);
  if (normalized.length === 0) {
    safeLocalStorageSet(EXTENSIONS_STORAGE_KEY, JSON.stringify(DEFAULT_GLOBAL_SEARCH_EXTENSIONS));
  } else {
    safeLocalStorageSet(EXTENSIONS_STORAGE_KEY, JSON.stringify([...new Set(normalized)]));
  }
  globalSearchSettingsVersion.value++;
  void persistGlobalSearchSettings();
}

export function saveGlobalSearchMatchMode(mode: GlobalSearchMatchMode): void {
  safeLocalStorageSet(MATCH_MODE_STORAGE_KEY, mode === "enhanced" ? "enhanced" : DEFAULT_GLOBAL_SEARCH_MATCH_MODE);
  globalSearchSettingsVersion.value++;
  void persistGlobalSearchSettings();
}

export function saveGlobalSearchShowQuickFilters(show: boolean): void {
  safeLocalStorageSet(SHOW_QUICK_FILTERS_STORAGE_KEY, show ? "true" : "false");
  globalSearchSettingsVersion.value++;
  void persistGlobalSearchSettings();
}

export function saveGlobalSearchItemTypes(itemTypes: Partial<GlobalSearchItemTypes>): void {
  const current = getGlobalSearchItemTypes();
  const next = Object.fromEntries(GLOBAL_SEARCH_ITEM_TYPES.map((type) => [type, itemTypes[type] ?? current[type]])) as GlobalSearchItemTypes;
  safeLocalStorageSet(SEARCH_ITEM_TYPES_STORAGE_KEY, JSON.stringify(next));
  globalSearchSettingsVersion.value++;
  void persistGlobalSearchSettings();
}

/** Persist the current roots + extensions to disk (Tauri) for durable storage. */
function persistGlobalSearchSettings(): void {
  globalSearchSettingsWriteQueue = globalSearchSettingsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await api.saveGlobalSearchSettings(globalSearchSettingsPayload());
      } catch {
        // Web/browser mode may not expose persistence; ignore.
      }
    });
}

/**
 * Hydrate the localStorage-backed settings from the disk store once at startup.
 * Prefers configured SQL-file folders, so this only seeds extra roots/extensions.
 */
export async function initializeGlobalSearchSettings(): Promise<void> {
  const revisionAtStart = globalSearchSettingsVersion.value;
  const initialRoots = getGlobalSearchRoots();
  const initialExtensions = getGlobalSearchExtensions();
  const initialMatchMode = getGlobalSearchMatchMode();
  const initialShowQuickFilters = getGlobalSearchShowQuickFilters();
  const initialItemTypes = getGlobalSearchItemTypes();
  const sameStrings = (left: string[], right: string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
  const sameItemTypes = (left: GlobalSearchItemTypes, right: GlobalSearchItemTypes): boolean => GLOBAL_SEARCH_ITEM_TYPES.every((type) => left[type] === right[type]);

  try {
    const disk = await api.loadGlobalSearchSettings();
    if (!disk) return;
    let hydrated = false;
    const localEditOccurred = globalSearchSettingsVersion.value !== revisionAtStart;
    const currentRoots = getGlobalSearchRoots();
    const currentExtensions = getGlobalSearchExtensions();
    const currentMatchMode = getGlobalSearchMatchMode();
    const currentShowQuickFilters = getGlobalSearchShowQuickFilters();
    const currentItemTypes = getGlobalSearchItemTypes();

    if (Array.isArray(disk.roots) && disk.roots.length > 0 && (!localEditOccurred || sameStrings(currentRoots, initialRoots))) {
      const roots = normalizeRoots(disk.roots);
      safeLocalStorageSet(ROOTS_STORAGE_KEY, JSON.stringify(roots));
      hydrated = true;
    }
    if (Array.isArray(disk.extensions) && disk.extensions.length > 0 && (!localEditOccurred || sameStrings(currentExtensions, initialExtensions))) {
      const extensions = normalizeExtensions(disk.extensions);
      if (extensions.length > 0) safeLocalStorageSet(EXTENSIONS_STORAGE_KEY, JSON.stringify(extensions));
      hydrated = true;
    }
    if ((disk.matchMode === "precise" || disk.matchMode === "enhanced") && (!localEditOccurred || currentMatchMode === initialMatchMode)) {
      safeLocalStorageSet(MATCH_MODE_STORAGE_KEY, disk.matchMode);
      hydrated = true;
    }
    if (typeof disk.showQuickFilters === "boolean" && (!localEditOccurred || currentShowQuickFilters === initialShowQuickFilters)) {
      safeLocalStorageSet(SHOW_QUICK_FILTERS_STORAGE_KEY, disk.showQuickFilters ? "true" : "false");
      hydrated = true;
    }
    if (disk.itemTypes && typeof disk.itemTypes === "object" && (!localEditOccurred || sameItemTypes(currentItemTypes, initialItemTypes))) {
      const itemTypes = Object.fromEntries(GLOBAL_SEARCH_ITEM_TYPES.map((type) => [type, (disk.itemTypes as Record<string, unknown>)[type] !== false])) as GlobalSearchItemTypes;
      safeLocalStorageSet(SEARCH_ITEM_TYPES_STORAGE_KEY, JSON.stringify(itemTypes));
      hydrated = true;
    }
    if (hydrated) {
      globalSearchSettingsVersion.value++;
      persistGlobalSearchSettings();
    }
  } catch {
    // No disk store (pure web mode) — keep current values.
  }
}

// Seed from disk once on import; later saves also write back to disk.
void initializeGlobalSearchSettings();

/** Union of the configured SQL file folders and the extra global-search roots. */
export function composeGlobalSearchRoots(): string[] {
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const root of [...getSqlFileFolderPaths(), ...getGlobalSearchRoots()]) {
    const normalized = root.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    combined.push(normalized);
  }
  return combined;
}
