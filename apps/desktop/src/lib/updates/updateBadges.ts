export function driverStoreUpdateBadgeCount(autoUpdateDrivers: boolean, autoUpdateJdbc: boolean, driverUpdateCount: number, jdbcUpdateAvailable: boolean): number {
  return (autoUpdateDrivers ? 0 : driverUpdateCount) + (!autoUpdateJdbc && jdbcUpdateAvailable ? 1 : 0);
}

export function showMcpUpdateBadge(autoUpdateMcp: boolean, mcpUpdateAvailable: boolean): boolean {
  return !autoUpdateMcp && mcpUpdateAvailable;
}

export function showToolbarUpdateAction(options: { appUpdateAvailable: boolean; driverUpdateCount: number; jdbcUpdateAvailable: boolean; mcpUpdateAvailable: boolean; pluginUpdateCount: number; componentUpdatesRunning: boolean }): boolean {
  // Installation refreshes before replacing components, so discovery can report pending entries mid-operation.
  if (options.componentUpdatesRunning) return false;
  return options.appUpdateAvailable || options.driverUpdateCount > 0 || options.jdbcUpdateAvailable || options.mcpUpdateAvailable || options.pluginUpdateCount > 0;
}
