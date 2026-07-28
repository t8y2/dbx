import { computed, ref, type Ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const NACOS_CONFIG_LIST_COLUMN_WIDTHS_STORAGE_KEY = "dbx-nacos-config-list-column-widths";
export const DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS = [280, 180, 180, 96] as const;
export const NACOS_CONFIG_LIST_HORIZONTAL_PADDING = 24;
const MIN_NACOS_CONFIG_LIST_COLUMN_WIDTHS = [140, 96, 96, 72] as const;

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

function gridTemplateColumnsForWidths(widths: readonly number[]) {
  return widths.map((width) => `${width}px`).join(" ");
}

export function fitNacosConfigListColumnWidths(widths: readonly number[], availableWidth: number): number[] {
  const normalized = normalizeNacosConfigListColumnWidths([...widths]) ?? [...DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS];
  const targetWidth = Math.floor(availableWidth) - NACOS_CONFIG_LIST_HORIZONTAL_PADDING;
  if (targetWidth <= 0) return normalized;

  const minimums = normalized.map((_, index) => minWidthForColumn(index));
  const minimumTotal = minimums.reduce((sum, width) => sum + width, 0);
  if (targetWidth <= minimumTotal) return minimums;

  const preferredExtras = normalized.map((width, index) => Math.max(0, width - minimums[index]!));
  const preferredExtraTotal = preferredExtras.reduce((sum, width) => sum + width, 0);
  const availableExtra = targetWidth - minimumTotal;
  const fitted = minimums.map((minimum, index) => {
    const weight = preferredExtraTotal > 0 ? preferredExtras[index]! / preferredExtraTotal : 1 / minimums.length;
    return minimum + Math.floor(availableExtra * weight);
  });
  fitted[fitted.length - 1]! += targetWidth - fitted.reduce((sum, width) => sum + width, 0);
  return fitted;
}

export function useNacosConfigListColumnResize(availableWidth?: Readonly<Ref<number>>) {
  const preferredColumnWidths = ref(loadNacosConfigListColumnWidths());
  const resizingColumnIndex = ref<number | null>(null);
  const columnWidths = computed(() => {
    const width = availableWidth?.value ?? 0;
    return width > 0 ? fitNacosConfigListColumnWidths(preferredColumnWidths.value, width) : preferredColumnWidths.value;
  });
  const gridTemplateColumns = computed(() => gridTemplateColumnsForWidths(columnWidths.value));
  const totalWidth = computed(() => columnWidths.value.reduce((sum, width) => sum + width, 0));
  const minWidth = computed(() => `${totalWidth.value + NACOS_CONFIG_LIST_HORIZONTAL_PADDING}px`);

  function onResizeStart(columnIndex: number, event: MouseEvent) {
    if (columnIndex < 0 || columnIndex >= columnWidths.value.length - 1) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidths = [...columnWidths.value];
    const startWidth = startWidths[columnIndex] ?? minWidthForColumn(columnIndex);
    const nextStartWidth = startWidths[columnIndex + 1] ?? minWidthForColumn(columnIndex + 1);
    const pairWidth = startWidth + nextStartWidth;
    resizingColumnIndex.value = columnIndex;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const minimum = minWidthForColumn(columnIndex);
      const nextMinimum = minWidthForColumn(columnIndex + 1);
      const width = Math.min(pairWidth - nextMinimum, Math.max(minimum, startWidth + delta));
      const nextWidths = [...startWidths];
      nextWidths[columnIndex] = width;
      nextWidths[columnIndex + 1] = pairWidth - width;
      preferredColumnWidths.value = nextWidths;
    };

    const onUp = (moveEvent: MouseEvent) => {
      onMove(moveEvent);
      resizingColumnIndex.value = null;
      preferredColumnWidths.value = [...columnWidths.value];
      saveNacosConfigListColumnWidths(preferredColumnWidths.value);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return {
    columnWidths,
    gridTemplateColumns,
    totalWidth,
    minWidth,
    resizingColumnIndex,
    onResizeStart,
  };
}
