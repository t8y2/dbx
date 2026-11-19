import { ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { getSqlFileFolderPaths } from "@/lib/sqlFile/sqlFileFolders";
import * as api from "@/lib/backend/api";

const ROOTS_STORAGE_KEY = "dbx-global-search-roots";
const EXTENSIONS_STORAGE_KEY = "dbx-global-search-extensions";
export const DEFAULT_GLOBAL_SEARCH_EXTENSIONS = ["sql"];

/**
 * Shared reactive version counter — bumped whenever global-search settings change.
 * useQuickOpen watches this to know when to re-run the current search.
 */
export const globalSearchSettingsVersion = ref(0);

/** Additional search root directories (on top of the configured SQL file folders). */
export function getGlobalSearchRoots(): string[] {
  try {
    const raw = safeLocalStorageGet(ROOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
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
        const normalized = parsed
          .filter((ext): ext is string => typeof ext === "string")
          .map((ext) => ext.trim().replace(/^\.+/, "").toLowerCase())
          .filter((ext) => ext.length > 0);
        if (normalized.length > 0) return normalized;
      }
    }
  } catch {
    // fall through to default
  }
  return [...DEFAULT_GLOBAL_SEARCH_EXTENSIONS];
}

export function saveGlobalSearchRoots(roots: string[]): void {
  const normalized = [...new Set(roots.map((root) => root.trim()).filter((root) => root.length > 0))];
  safeLocalStorageSet(ROOTS_STORAGE_KEY, JSON.stringify(normalized));
  globalSearchSettingsVersion.value++;
  void persistGlobalSearchSettings();
}

export function saveGlobalSearchExtensions(extensions: string[]): void {
  const normalized = extensions.map((ext) => ext.trim().replace(/^\.+/, "").toLowerCase()).filter((ext) => ext.length > 0);
  if (normalized.length === 0) {
    safeLocalStorageSet(EXTENSIONS_STORAGE_KEY, JSON.stringify(DEFAULT_GLOBAL_SEARCH_EXTENSIONS));
  } else {
    safeLocalStorageSet(EXTENSIONS_STORAGE_KEY, JSON.stringify([...new Set(normalized)]));
  }
  globalSearchSettingsVersion.value++;
  void persistGlobalSearchSettings();
}

/** Persist the current roots + extensions to disk (Tauri) for durable storage. */
async function persistGlobalSearchSettings(): Promise<void> {
  try {
    await api.saveGlobalSearchSettings({
      roots: getGlobalSearchRoots(),
      extensions: getGlobalSearchExtensions(),
    });
  } catch (error) {
    // Web/browser mode may not expose persistence; ignore.
  }
}

/**
 * Hydrate the localStorage-backed settings from the disk store once at startup.
 * Prefers configured SQL-file folders, so this only seeds extra roots/extensions.
 */
export async function initializeGlobalSearchSettings(): Promise<void> {
  try {
    const disk = await api.loadGlobalSearchSettings();
    if (!disk) return;
    if (Array.isArray(disk.roots) && disk.roots.length > 0) {
      saveGlobalSearchRoots(disk.roots);
    }
    if (Array.isArray(disk.extensions) && disk.extensions.length > 0) {
      saveGlobalSearchExtensions(disk.extensions);
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
