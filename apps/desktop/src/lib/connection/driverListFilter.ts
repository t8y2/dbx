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
