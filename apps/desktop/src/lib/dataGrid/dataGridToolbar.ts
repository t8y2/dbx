export const DATA_GRID_COMPACT_TOPBAR_WIDTH = 900;

export type DataGridReloadIntent = "refresh";

export interface DataGridToolbarActionCapability {
  label: string;
  tooltip?: string;
  visible?: boolean;
  disabled?: boolean;
  active?: boolean;
  loading?: boolean;
  onTrigger: () => void | Promise<void>;
}

export interface DataGridToolbarSaveCapability extends DataGridToolbarActionCapability {
  pendingCount: number;
  shortcutLabel?: string;
}

export interface DataGridToolbarMenuItem {
  value: string;
  label: string;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface DataGridToolbarExportCapability {
  label: string;
  visible?: boolean;
  disabled?: boolean;
  items: readonly DataGridToolbarMenuItem[];
  onSelect: (value: string) => void | Promise<void>;
}

export interface DataGridToolbarAutoRefreshCapability {
  label: string;
  shortLabel: string;
  startLabel: string;
  stopLabel: string;
  visible?: boolean;
  disabled?: boolean;
  enabled: boolean;
  intervalSeconds: number;
  intervalOptions: readonly number[];
  intervalLabel: (seconds: number) => string;
  onToggle: () => void | Promise<void>;
  onSelectInterval: (seconds: number) => void | Promise<void>;
}

export function isDataGridToolbarCapabilityVisible(capability: { visible?: boolean } | undefined): boolean {
  return !!capability && capability.visible !== false;
}

export function isDataGridToolbarCapabilityDisabled(capability: { disabled?: boolean; loading?: boolean } | undefined): boolean {
  return !capability || capability.disabled === true;
}

export async function triggerDataGridToolbarAction(capability: DataGridToolbarActionCapability | undefined): Promise<boolean> {
  if (!capability || !isDataGridToolbarCapabilityVisible(capability) || isDataGridToolbarCapabilityDisabled(capability)) return false;
  await capability.onTrigger();
  return true;
}

export function dataGridToolbarIntervalOptions(intervalOptions: readonly number[], currentIntervalSeconds: number): number[] {
  // Keep a persisted custom interval selectable even when it is not in today's preset list.
  return [...new Set([...intervalOptions, currentIntervalSeconds].filter((seconds) => Number.isInteger(seconds) && seconds > 0))].sort((left, right) => left - right);
}

export async function toggleDataGridToolbarAutoRefresh(capability: DataGridToolbarAutoRefreshCapability | undefined): Promise<boolean> {
  if (!capability || !isDataGridToolbarCapabilityVisible(capability) || isDataGridToolbarCapabilityDisabled(capability)) return false;
  await capability.onToggle();
  return true;
}

export async function selectDataGridToolbarAutoRefreshInterval(capability: DataGridToolbarAutoRefreshCapability | undefined, seconds: number): Promise<boolean> {
  if (!capability || !isDataGridToolbarCapabilityVisible(capability) || isDataGridToolbarCapabilityDisabled(capability)) return false;
  if (!dataGridToolbarIntervalOptions(capability.intervalOptions, capability.intervalSeconds).includes(seconds)) return false;
  await capability.onSelectInterval(seconds);
  return true;
}

export async function selectDataGridToolbarExportItem(capability: DataGridToolbarExportCapability | undefined, value: string): Promise<boolean> {
  if (!capability || !isDataGridToolbarCapabilityVisible(capability) || capability.disabled) return false;
  const item = capability.items.find((candidate) => candidate.value === value);
  if (!item || item.disabled) return false;
  await capability.onSelect(value);
  return true;
}
