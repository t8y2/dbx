import { computed, ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const NACOS_CONFIG_LIST_COLUMN_WIDTHS_STORAGE_KEY = "dbx-nacos-config-list-column-widths";
export const DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS = [280, 180, 180, 96] as const;
const MIN_NACOS_CONFIG_LIST_COLUMN_WIDTHS = [180, 120, 120, 72] as const;

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

export function useNacosConfigListColumnResize() {
  const columnWidths = ref(loadNacosConfigListColumnWidths());
  const resizingColumnIndex = ref<number | null>(null);
  const gridTemplateColumns = computed(() => gridTemplateColumnsForWidths(columnWidths.value));
  const totalWidth = computed(() => columnWidths.value.reduce((sum, width) => sum + width, 0));
  const minWidth = computed(() => `${totalWidth.value}px`);

  function onResizeStart(columnIndex: number, event: MouseEvent) {
    if (columnIndex < 0 || columnIndex >= columnWidths.value.length) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnWidths.value[columnIndex] ?? minWidthForColumn(columnIndex);
    resizingColumnIndex.value = columnIndex;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      columnWidths.value[columnIndex] = Math.max(minWidthForColumn(columnIndex), startWidth + delta);
    };

    const onUp = (moveEvent: MouseEvent) => {
      onMove(moveEvent);
      resizingColumnIndex.value = null;
      saveNacosConfigListColumnWidths(columnWidths.value);
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
