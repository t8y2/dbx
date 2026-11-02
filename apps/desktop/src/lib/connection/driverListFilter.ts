import type { AgentDriverInfo } from "@/lib/backend/api";

/** Orthogonal to category: inventory vs catalog. Default is `"all"`. */
export type DriverInstallStatusFilter = "all" | "installed" | "available";

export function selectDriversByInstallStatus(drivers: readonly AgentDriverInfo[], status: DriverInstallStatusFilter): AgentDriverInfo[] {
  if (status === "installed") return drivers.filter((d) => d.installed);
  if (status === "available") return drivers.filter((d) => !d.installed);
  return [...drivers];
}

export function countInstalledDrivers(drivers: readonly AgentDriverInfo[]): number {
  return drivers.reduce((count, driver) => count + (driver.installed ? 1 : 0), 0);
}

export function countAvailableDrivers(drivers: readonly AgentDriverInfo[]): number {
  return drivers.length - countInstalledDrivers(drivers);
}

export interface PartitionedDriverList {
  updatable: AgentDriverInfo[];
  stable: AgentDriverInfo[];
}

/**
 * Banner vs list partition for the current install-status filter.
 *
 * The update banner is hidden on `"available"`. Uninstalled rows with
 * `update_available` (stale local registry / missing jar) must stay in the
 * list, not disappear from both surfaces. On `"installed"` the banner only
 * includes installed updatables.
 */
export function partitionDriversByInstallStatus(drivers: readonly AgentDriverInfo[], status: DriverInstallStatusFilter): PartitionedDriverList {
  const statusFiltered = selectDriversByInstallStatus(drivers, status);
  if (status === "available") {
    return { updatable: [], stable: statusFiltered };
  }
  const updatable = selectUpdatableDrivers(statusFiltered);
  const updatableKeys = new Set(updatable.map((driver) => driver.db_type));
  return {
    updatable,
    stable: statusFiltered.filter((driver) => !updatableKeys.has(driver.db_type)),
  };
}

/** Driver keys the visible update banner would upgrade. */
export function upgradeAllDriverTypes(drivers: readonly AgentDriverInfo[], status: DriverInstallStatusFilter): string[] {
  return partitionDriversByInstallStatus(drivers, status).updatable.map((driver) => driver.db_type);
}

/**
 * True when a batch `upgradeAllAgents` (every `update_available` row) would
 * match the visible banner. False on Installed when a stale uninstalled
 * updatable exists — per-row Update stays, the global batch button does not.
 */
export function upgradeAllMatchesFullUpdateSet(drivers: readonly AgentDriverInfo[], status: DriverInstallStatusFilter): boolean {
  const visible = upgradeAllDriverTypes(drivers, status);
  const all = selectUpdatableDrivers(drivers).map((driver) => driver.db_type);
  if (visible.length !== all.length) return false;
  const visibleKeys = new Set(visible);
  return all.every((key) => visibleKeys.has(key));
}

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
  /**
   * Current install-status filter. Updatable drivers are already installed, so
   * `"available"` hides the update banner and must not suppress the empty state.
   */
  installStatus?: DriverInstallStatusFilter;
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
  if (opts.installStatus === "available") return false;
  if (opts.searchQuery) {
    return updatableDrivers.some((d) => opts.driverMatchesSearch(d, opts.searchQuery));
  }
  if (opts.selectedCategory !== "all") {
    return updatableDrivers.some((d) => opts.driverCategory(d) === opts.selectedCategory);
  }
  return true;
}
