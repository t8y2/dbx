const DATA_GRID_COMPACT_TOPBAR_MIN_WIDTH = 900;
const DATA_GRID_COMPACT_TOPBAR_MAX_WIDTH = 1050;
const DATA_GRID_COMPACT_TOPBAR_VIEWPORT_RATIO = 0.75;
const DATA_GRID_TOOLBAR_ACTION_COLLAPSE_STEP = 40;
export const DATA_GRID_CONDITION_TOOLBAR_MIN_WIDTH = DATA_GRID_COMPACT_TOPBAR_MAX_WIDTH;

export const DATA_GRID_TOOLBAR_ACTION_COLLAPSE_ORDER = ["refresh", "autoRefresh", "navigation", "copyData", "addRow", "deleteRow", "exportData", "transpose", "tableInfo", "layerPreview", "preview", "save", "rollback"] as const;

export type DataGridToolbarActionKey = (typeof DATA_GRID_TOOLBAR_ACTION_COLLAPSE_ORDER)[number];

export function dataGridToolbarCompactBreakpoint(viewportWidth: number, minimumWidth = DATA_GRID_COMPACT_TOPBAR_MIN_WIDTH): number {
  const normalizedViewportWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : DATA_GRID_COMPACT_TOPBAR_MAX_WIDTH;
  const normalizedMinimumWidth = Math.min(DATA_GRID_COMPACT_TOPBAR_MAX_WIDTH, Math.max(DATA_GRID_COMPACT_TOPBAR_MIN_WIDTH, minimumWidth));
  return Math.min(DATA_GRID_COMPACT_TOPBAR_MAX_WIDTH, Math.max(normalizedMinimumWidth, normalizedViewportWidth * DATA_GRID_COMPACT_TOPBAR_VIEWPORT_RATIO));
}

export function isDataGridToolbarCompact(toolbarWidth: number, viewportWidth: number, minimumWidth?: number): boolean {
  return toolbarWidth > 0 && toolbarWidth < dataGridToolbarCompactBreakpoint(viewportWidth, minimumWidth);
}

export function dataGridToolbarActionCollapseCount(toolbarWidth: number, viewportWidth: number, minimumWidth?: number): number {
  if (!Number.isFinite(toolbarWidth) || toolbarWidth <= 0) return 0;
  const deficit = dataGridToolbarCompactBreakpoint(viewportWidth, minimumWidth) - toolbarWidth;
  if (deficit <= 0) return 0;
  return Math.min(DATA_GRID_TOOLBAR_ACTION_COLLAPSE_ORDER.length, Math.ceil(deficit / DATA_GRID_TOOLBAR_ACTION_COLLAPSE_STEP));
}

export function isDataGridToolbarActionCompact(action: DataGridToolbarActionKey, visibleActions: readonly DataGridToolbarActionKey[], compactActionCount: number, forceCompact = false): boolean {
  if (forceCompact) return true;
  const actionIndex = visibleActions.indexOf(action);
  if (actionIndex < 0) return false;
  return actionIndex < Math.max(0, Math.floor(compactActionCount));
}

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

export function dataGridDeleteRowToolbarState(options: { editable: boolean; canDeleteRows: boolean; canDeleteExistingRows: boolean; deletableTargetCount: number; isSaving: boolean }): { visible: boolean; disabled: boolean } {
  const deletionAvailable = options.editable && options.canDeleteRows;
  return {
    visible: deletionAvailable && (options.canDeleteExistingRows || options.deletableTargetCount > 0),
    disabled: options.isSaving || options.deletableTargetCount === 0,
  };
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
  /** Marks a menu item as the active choice in a mutually-exclusive group (rendered as a check). */
  selected?: boolean;
}

export interface DataGridToolbarExportCapability {
  label: string;
  visible?: boolean;
  disabled?: boolean;
  items: readonly DataGridToolbarMenuItem[];
  onSelect: (value: string) => void | Promise<void>;
}

export interface DataGridToolbarCopyCapability {
  label: string;
  tooltip?: string;
  visible?: boolean;
  disabled?: boolean;
  currentValue: string;
  items: readonly DataGridToolbarMenuItem[];
  onCopy: () => void | Promise<void>;
  onSelect: (value: string) => void | Promise<void>;
}

export interface DataGridToolbarAddRowCapability {
  label: string;
  tooltip?: string;
  visible?: boolean;
  disabled?: boolean;
  items: readonly DataGridToolbarMenuItem[];
  onTrigger: () => void | Promise<void>;
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

export async function triggerDataGridToolbarCopy(capability: DataGridToolbarCopyCapability | undefined): Promise<boolean> {
  if (!capability || !isDataGridToolbarCapabilityVisible(capability) || capability.disabled) return false;
  await capability.onCopy();
  return true;
}

export async function selectDataGridToolbarCopyItem(capability: DataGridToolbarCopyCapability | undefined, value: string): Promise<boolean> {
  if (!capability || !isDataGridToolbarCapabilityVisible(capability)) return false;
  const item = capability.items.find((candidate) => candidate.value === value);
  if (!item || item.disabled) return false;
  await capability.onSelect(value);
  return true;
}

export async function selectDataGridToolbarAddRowItem(capability: DataGridToolbarAddRowCapability | undefined, value: string): Promise<boolean> {
  if (!capability || !isDataGridToolbarCapabilityVisible(capability) || capability.disabled) return false;
  const item = capability.items.find((candidate) => candidate.value === value);
  if (!item || item.disabled) return false;
  await capability.onSelect(value);
  return true;
}
