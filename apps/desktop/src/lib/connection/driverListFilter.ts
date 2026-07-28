import type { AgentDriverInfo } from "@/lib/backend/api";

/**
 * Drivers that have an update available — always rendered above category
 * navigation so the user can see and act on them regardless of the active
 * category filter.
 */
export function selectUpdatableDrivers(drivers: readonly AgentDriverInfo[]): AgentDriverInfo[] {
  return drivers.filter((d) => d.update_available);
}

/**
 * Category-filtered drivers *excluding* updatable ones — the per‑item
 * "Update" action lives in the global update section, so the category
 * list only renders stable (non‑updatable) rows.
 */
export function selectStableDrivers(drivers: readonly AgentDriverInfo[]): AgentDriverInfo[] {
  return drivers.filter((d) => !d.update_available);
}

export interface UpdatableDriverMatchOptions {
  /** Lowercased search query (empty string when search is inactive). */
  searchQuery: string;
  /** Currently selected category key ("all" when no specific category). */
  selectedCategory: string;
  /** Predicate: does `driver` match `query` (already lowercased)? */
  driverMatchesSearch: (driver: AgentDriverInfo, query: string) => boolean;
  /** Returns the category key for `driver`. */
  driverCategory: (driver: AgentDriverInfo) => string;
}

/**
 * Returns `true` when at least one driver in `updatableDrivers` is relevant to
 * the current view (search query or selected category).  Used to decide whether
 * an empty‑state message should be suppressed: the global update section always
 * renders *all* updatable drivers, so the empty‑state must only be hidden when
 * at least one of those drivers is actually relevant.
 */
export function hasAnyUpdatableDriverMatching(updatableDrivers: readonly AgentDriverInfo[], opts: UpdatableDriverMatchOptions): boolean {
  if (updatableDrivers.length === 0) return false;
  if (opts.searchQuery) {
    return updatableDrivers.some((d) => opts.driverMatchesSearch(d, opts.searchQuery));
  }
  if (opts.selectedCategory !== "all") {
    return updatableDrivers.some((d) => opts.driverCategory(d) === opts.selectedCategory);
  }
  return true;
}
