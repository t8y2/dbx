import type { TableInfo } from "@/types/database";

/**
 * In-flight full-index builds, keyed by sidebar scope (parent node id).
 *
 * A missing persisted index (read returns null) means the scope was never
 * indexed, so only the currently loaded first page of children would be
 * searchable. That silently misses alphabetically-late tables — e.g.
 * "T_Erp_Nc_SuPlan_List" for the fuzzy query "erpncs" — until an explicit
 * index refresh happens (the refresh button). Building the index on the first
 * search makes the complete table set searchable from the start, matching the
 * behavior of an explicit refresh.
 *
 * Building pages through every table of a scope, so rapid consecutive first
 * searches must never start concurrent full builds: while one build for a
 * scope is in flight, further requests reuse the same promise instead of
 * spawning a duplicate scan. Entries are removed once the build settles
 * (success or failure) so a later search can retry.
 */
const inFlightSidebarTableSearchBuilds = new Map<string, Promise<TableInfo[]>>();

/**
 * Stop a later explicit refresh from reusing a build that started before the
 * underlying table list was refreshed. The old promise may still settle, but
 * callers can start a new build for the same scope immediately.
 */
export function invalidateSidebarTableSearchBuild(scopeKey: string): void {
  inFlightSidebarTableSearchBuilds.delete(scopeKey);
}

function dedupeInFlightBuild(scopeKey: string, build: () => Promise<TableInfo[]>): Promise<TableInfo[]> {
  const existing = inFlightSidebarTableSearchBuilds.get(scopeKey);
  if (existing) return existing;
  let pending!: Promise<TableInfo[]>;
  pending = (async () => {
    try {
      return await build();
    } finally {
      if (inFlightSidebarTableSearchBuilds.get(scopeKey) === pending) {
        inFlightSidebarTableSearchBuilds.delete(scopeKey);
      }
    }
  })();
  inFlightSidebarTableSearchBuilds.set(scopeKey, pending);
  return pending;
}

/**
 * Load the local table search index for a sidebar scope, building it on first
 * use — exactly once per scope, even under rapid consecutive input.
 *
 * - An empty (or cleared) query filters nothing, so no read or build happens:
 *   clearing the input must not scan every page of the table set for nothing.
 * - An explicit refresh (`refresh = true`) always rebuilds, but still through
 *   the in-flight lock so double-clicks cannot start duplicate full builds.
 * - A persisted index is reused without rebuilding; a missing one is built
 *   through the lock, and concurrent callers share the same build promise.
 */
export async function loadOrBuildSidebarTableSearchIndex(scopeKey: string, query: string, read: () => Promise<TableInfo[] | null>, build: () => Promise<TableInfo[]>, refresh = false): Promise<TableInfo[] | null> {
  if (!refresh && !query.trim()) return null;
  if (refresh) return dedupeInFlightBuild(scopeKey, build);
  const entries = await read();
  if (entries) return entries;
  return dedupeInFlightBuild(scopeKey, build);
}

export interface SidebarTableSearchDebouncer {
  /** Debounce a per-key load; consecutive calls for the same key within the window coalesce. */
  schedule(key: string, run: () => void): void;
  /** Cancel a pending (scheduled, not yet run) load for a key. */
  cancel(key: string): void;
  /** Cancel every pending load. */
  cancelAll(): void;
  /** Number of pending (scheduled, not yet run) loads. */
  pendingCount(): number;
}

/**
 * Per-key debouncer used to coalesce rapid table-search input into a single
 * load/build. Each schedule() for the same key resets the window, so fast
 * typing issues one load instead of one full index build per keystroke.
 */
export function createSidebarTableSearchDebouncer(delayMs = 250): SidebarTableSearchDebouncer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(key, run) {
      const existing = timers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        timers.delete(key);
        run();
      }, delayMs);
      timers.set(key, timer);
    },
    cancel(key) {
      const existing = timers.get(key);
      if (existing !== undefined) {
        clearTimeout(existing);
        timers.delete(key);
      }
    },
    cancelAll() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    pendingCount() {
      return timers.size;
    },
  };
}

export function scheduleExclusiveSidebarTableSearchDebounce(key: string, active: SidebarTableSearchDebouncer, inactive: SidebarTableSearchDebouncer, run: () => void): void {
  inactive.cancel(key);
  active.schedule(key, run);
}
