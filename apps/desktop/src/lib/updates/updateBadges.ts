export function driverStoreUpdateBadgeCount(autoUpdateDrivers: boolean, autoUpdateJdbc: boolean, driverUpdateCount: number, jdbcUpdateAvailable: boolean): number {
  return (autoUpdateDrivers ? 0 : driverUpdateCount) + (!autoUpdateJdbc && jdbcUpdateAvailable ? 1 : 0);
}

export function showMcpUpdateBadge(autoUpdateMcp: boolean, mcpUpdateAvailable: boolean): boolean {
  return !autoUpdateMcp && mcpUpdateAvailable;
}
