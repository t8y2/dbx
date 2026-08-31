import { computed, ref, type Ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const NACOS_CONFIG_LIST_COLUMN_WIDTHS_STORAGE_KEY = "dbx-nacos-config-list-column-widths";
export const NACOS_CONFIG_LIST_HIDDEN_COLUMNS_STORAGE_KEY = "dbx-nacos-config-list-hidden-columns";
export const DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS = [280, 180, 180, 96] as const;
export const NACOS_CONFIG_LIST_HORIZONTAL_PADDING = 24;
const MIN_NACOS_CONFIG_LIST_COLUMN_WIDTHS = [140, 96, 96, 72] as const;
const NACOS_CONFIG_LIST_COLUMNS = ["dataId", "group", "application", "format"] as const;
const TOGGLEABLE_NACOS_CONFIG_LIST_COLUMNS = ["group", "application", "format"] as const;

export type NacosConfigListColumnKey = (typeof NACOS_CONFIG_LIST_COLUMNS)[number];
export type ToggleableNacosConfigListColumnKey = (typeof TOGGLEABLE_NACOS_CONFIG_LIST_COLUMNS)[number];

function isToggleableColumn(key: unknown): key is ToggleableNacosConfigListColumnKey {
  return TOGGLEABLE_NACOS_CONFIG_LIST_COLUMNS.includes(key as ToggleableNacosConfigListColumnKey);
}

function minWidthForColumn(index: number) {
  return MIN_NACOS_CONFIG_LIST_COLUMN_WIDTHS[index] ?? MIN_NACOS_CONFIG_LIST_COLUMN_WIDTHS[MIN_NACOS_CONFIG_LIST_COLUMN_WIDTHS.length - 1];
}

function normalizeNacosConfigListColumnWidths(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS.length) return null;
  const widths = value.map((item) => Number(item));
  if (widths.some((item) => !Number.isFinite(item))) return null;
  return widths.map((width, index) => Math.max(minWidthForColumn(index), width));
}

function loadNacosConfigListColumnWidths(): number[] {
  const raw = safeLocalStorageGet(NACOS_CONFIG_LIST_COLUMN_WIDTHS_STORAGE_KEY);
  if (!raw) return [...DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS];
  try {
    const normalized = normalizeNacosConfigListColumnWidths(JSON.parse(raw));
    return normalized ?? [...DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS];
  } catch {
    return [...DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS];
  }
}

function saveNacosConfigListColumnWidths(widths: readonly number[]) {
  const normalized = normalizeNacosConfigListColumnWidths([...widths]);
  if (!normalized) return;
  safeLocalStorageSet(NACOS_CONFIG_LIST_COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(normalized));
}

function loadNacosConfigListHiddenColumns(): ToggleableNacosConfigListColumnKey[] {
  const raw = safeLocalStorageGet(NACOS_CONFIG_LIST_HIDDEN_COLUMNS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(isToggleableColumn))];
  } catch {
    return [];
  }
}

function saveNacosConfigListHiddenColumns(columns: readonly ToggleableNacosConfigListColumnKey[]) {
  const normalized = [...new Set(columns.filter(isToggleableColumn))];
  if (normalized.length === 0) {
    safeLocalStorageRemove(NACOS_CONFIG_LIST_HIDDEN_COLUMNS_STORAGE_KEY);
    return;
  }
  safeLocalStorageSet(NACOS_CONFIG_LIST_HIDDEN_COLUMNS_STORAGE_KEY, JSON.stringify(normalized));
}

function gridTemplateColumnsForWidths(widths: readonly number[]) {
  return widths.map((width) => `${width}px`).join(" ");
}

function fitNacosConfigListColumnWidthsForIndexes(widths: readonly number[], availableWidth: number, columnIndexes: readonly number[]): number[] {
  const normalized = normalizeNacosConfigListColumnWidths([...widths]) ?? [...DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS];
  const selectedWidths = columnIndexes.map((index) => normalized[index] ?? minWidthForColumn(index));
  const targetWidth = Math.floor(availableWidth) - NACOS_CONFIG_LIST_HORIZONTAL_PADDING;
  if (targetWidth <= 0) return selectedWidths;

  const minimums = columnIndexes.map((index) => minWidthForColumn(index));
  const minimumTotal = minimums.reduce((sum, width) => sum + width, 0);
  if (targetWidth <= minimumTotal) return minimums;

  const preferredExtras = selectedWidths.map((width, index) => Math.max(0, width - minimums[index]!));
  const preferredExtraTotal = preferredExtras.reduce((sum, width) => sum + width, 0);
  const availableExtra = targetWidth - minimumTotal;
  const fitted = minimums.map((minimum, index) => {
    const weight = preferredExtraTotal > 0 ? preferredExtras[index]! / preferredExtraTotal : 1 / minimums.length;
    return minimum + Math.floor(availableExtra * weight);
  });
  fitted[fitted.length - 1]! += targetWidth - fitted.reduce((sum, width) => sum + width, 0);
  return fitted;
}

export function fitNacosConfigListColumnWidths(widths: readonly number[], availableWidth: number): number[] {
  return fitNacosConfigListColumnWidthsForIndexes(
    widths,
    availableWidth,
    DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS.map((_, index) => index),
  );
}

export function useNacosConfigListColumnResize(availableWidth?: Readonly<Ref<number>>) {
  const preferredColumnWidths = ref(loadNacosConfigListColumnWidths());
  const hiddenColumnKeys = ref(loadNacosConfigListHiddenColumns());
  const resizingColumnIndex = ref<number | null>(null);
  const visibleColumns = computed(() => NACOS_CONFIG_LIST_COLUMNS.filter((key) => !hiddenColumnKeys.value.includes(key as ToggleableNacosConfigListColumnKey)));
  const visibleColumnIndexes = computed(() => visibleColumns.value.map((key) => NACOS_CONFIG_LIST_COLUMNS.indexOf(key)));
  const columnWidths = computed(() => {
    const width = availableWidth?.value ?? 0;
    return width > 0 ? fitNacosConfigListColumnWidths(preferredColumnWidths.value, width) : preferredColumnWidths.value;
  });
  const visibleColumnWidths = computed(() => {
    const width = availableWidth?.value ?? 0;
    return width > 0 ? fitNacosConfigListColumnWidthsForIndexes(preferredColumnWidths.value, width, visibleColumnIndexes.value) : visibleColumnIndexes.value.map((index) => preferredColumnWidths.value[index]!);
  });
  const gridTemplateColumns = computed(() => gridTemplateColumnsForWidths(visibleColumnWidths.value));
  const totalWidth = computed(() => visibleColumnWidths.value.reduce((sum, width) => sum + width, 0));
  const minWidth = computed(() => `${totalWidth.value + NACOS_CONFIG_LIST_HORIZONTAL_PADDING}px`);

  function onResizeStart(columnIndex: number, event: MouseEvent) {
    if (columnIndex < 0 || columnIndex >= visibleColumnWidths.value.length - 1) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidths = [...visibleColumnWidths.value];
    const sourceIndex = visibleColumnIndexes.value[columnIndex]!;
    const nextIndex = visibleColumnIndexes.value[columnIndex + 1]!;
    const startWidth = startWidths[columnIndex] ?? minWidthForColumn(sourceIndex);
    const nextStartWidth = startWidths[columnIndex + 1] ?? minWidthForColumn(nextIndex);
    const pairWidth = startWidth + nextStartWidth;
    resizingColumnIndex.value = columnIndex;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const minimum = minWidthForColumn(sourceIndex);
      const nextMinimum = minWidthForColumn(nextIndex);
      const width = Math.min(pairWidth - nextMinimum, Math.max(minimum, startWidth + delta));
      const nextWidths = [...preferredColumnWidths.value];
      nextWidths[sourceIndex] = width;
      nextWidths[nextIndex] = pairWidth - width;
      preferredColumnWidths.value = nextWidths;
    };

    const onUp = (moveEvent: MouseEvent) => {
      onMove(moveEvent);
      resizingColumnIndex.value = null;
      const nextWidths = [...preferredColumnWidths.value];
      visibleColumnIndexes.value.forEach((index, visibleIndex) => {
        nextWidths[index] = visibleColumnWidths.value[visibleIndex]!;
      });
      preferredColumnWidths.value = nextWidths;
      saveNacosConfigListColumnWidths(preferredColumnWidths.value);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function isColumnVisible(column: NacosConfigListColumnKey) {
    return !hiddenColumnKeys.value.includes(column as ToggleableNacosConfigListColumnKey);
  }

  function setColumnVisible(column: ToggleableNacosConfigListColumnKey, visible: boolean) {
    const next = visible ? hiddenColumnKeys.value.filter((key) => key !== column) : [...new Set([...hiddenColumnKeys.value, column])];
    hiddenColumnKeys.value = next;
    saveNacosConfigListHiddenColumns(next);
  }

  return {
    columnWidths,
    visibleColumns,
    toggleableColumns: TOGGLEABLE_NACOS_CONFIG_LIST_COLUMNS,
    gridTemplateColumns,
    totalWidth,
    minWidth,
    resizingColumnIndex,
    onResizeStart,
    isColumnVisible,
    setColumnVisible,
  };
}
