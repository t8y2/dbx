export interface AgentDriverUpdateBadgeState {
  update_available: boolean;
}

export function countAvailableAgentDriverUpdates(drivers: readonly AgentDriverUpdateBadgeState[]): number {
  return drivers.filter((driver) => driver.update_available).length;
}

export interface JdbcPluginUpdateBadgeState {
  update_available?: boolean | null;
}

export function countAvailableDriverUpdates(drivers: readonly AgentDriverUpdateBadgeState[], jdbcPlugin?: JdbcPluginUpdateBadgeState | null): number {
  return countAvailableAgentDriverUpdates(drivers) + (jdbcPlugin?.update_available ? 1 : 0);
}
