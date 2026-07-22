<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Code2, Copy, Eye, Info, Pencil, Upload } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCellDetailEditor, type UseCellDetailEditorReturn } from "@/composables/useCellDetailEditor";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { BINARY_CELL_DOWNLOAD_MODES, type BinaryCellDownloadMode } from "@/lib/dataGrid/binaryCellDownload";
import { isGeometryColumnType } from "@/lib/dataGrid/cellDetailPresentation";
import { isHexGeometry, renderWktOnCanvas } from "@/lib/dataGrid/geometryPreview";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();

const props = defineProps<{
  detail: DataGridCellDetail | null;
  typeColorClass: (type: string) => string;
  openImagePreview: (src: string, title: string) => void;
  copyText: (text: string) => void;
  canDownloadBinaryValue: (detail: DataGridCellDetail | null) => boolean;
  downloadBinaryValue: (detail: DataGridCellDetail | null, mode: BinaryCellDownloadMode) => void | Promise<void>;
}>();

const emit = defineEmits<{
  edit: [];
}>();

const open = defineModel<boolean>("open", { default: false });
const geometryPreviewOpen = ref(false);
const geometryCanvas = ref<HTMLCanvasElement | null>(null);
const jsonPreviewContainer = ref<HTMLElement>();
let jsonPreviewEditor: UseCellDetailEditorReturn | null = null;

const jsonFormatted = computed(() => settingsStore.editorSettings.cellDetailJsonFormatted);
const jsonView = computed(() => jsonFormatted.value && !!props.detail?.formattedJson);

function toggleJsonFormatted() {
  settingsStore.updateEditorSettings({ cellDetailJsonFormatted: !jsonFormatted.value });
}

function copyCurrentValue() {
  const detail = props.detail;
  if (!detail) return;
  if (jsonView.value && detail.formattedJson) {
    props.copyText(detail.formattedJson);
    return;
  }
  props.copyText(detail.value === null ? "" : detail.rawValue);
}

function copyColumnName() {
  if (props.detail) props.copyText(props.detail.column);
}

watch(open, (isOpen) => {
  if (!isOpen) geometryPreviewOpen.value = false;
});

watch(
  () => props.detail,
  () => {
    geometryPreviewOpen.value = false;
  },
);

watch(geometryPreviewOpen, async (isOpen) => {
  if (!isOpen) return;
  await nextTick();
  const canvas = geometryCanvas.value;
  const detail = props.detail;
  if (canvas && detail?.value !== null && detail?.value !== undefined) {
    renderWktOnCanvas(canvas, String(detail.value));
  }
});

watch(jsonPreviewContainer, async (element) => {
  if (element && !jsonPreviewEditor) {
    jsonPreviewEditor = useCellDetailEditor({
      language: "json",
      readOnly: true,
      editorTheme: () => settingsStore.editorSettings.theme,
      appAppearance: () => (isDark.value ? "dark" : "light"),
      appPalette: () => themePalette.value,
      fontSize: () => settingsStore.editorSettings.fontSize,
      fontFamily: () => settingsStore.editorSettings.tableFontFamily,
    });
    await jsonPreviewEditor.create(element, props.detail?.formattedJson ?? "", "json");
  } else if (!element && jsonPreviewEditor) {
    jsonPreviewEditor.destroy();
    jsonPreviewEditor = null;
  }
});

watch(
  () => props.detail?.formattedJson ?? "",
  (value) => jsonPreviewEditor?.setValue(value, "json"),
);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent v-if="detail" class="sm:max-w-[840px] max-h-[85vh] flex flex-col overflow-hidden">
      <DialogHeader class="shrink-0 pr-8">
        <DialogTitle class="flex min-w-0 items-center gap-2 text-sm">
          <Info class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 truncate">{{ t("grid.cellDetails") }}</span>
        </DialogTitle>
      </DialogHeader>

      <div class="min-h-0 flex-1 overflow-auto pr-1 text-xs space-y-4">
        <div class="grid gap-3 rounded border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.columnName") }}</div>
            <div class="font-medium break-all">{{ detail.column }}</div>
          </div>
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.rowNumber") }}</div>
            <div>{{ detail.rowNumber }}</div>
          </div>
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.columnType") }}</div>
            <div :class="detail.type ? typeColorClass(detail.type) : 'text-muted-foreground'">{{ detail.type || "-" }}</div>
          </div>
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.valueLength") }}</div>
            <div>{{ detail.length }}</div>
          </div>
        </div>

        <div class="space-y-1">
          <div class="text-muted-foreground">{{ t("grid.columnComment") }}</div>
          <div class="whitespace-pre-wrap break-words">{{ detail.comment || t("grid.noComment") }}</div>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-muted-foreground">{{ t("grid.cellValue") }}</div>
            <div class="flex items-center gap-1">
              <Button v-if="detail.formattedJson" :variant="jsonView ? 'secondary' : 'ghost'" size="sm" class="h-6 gap-1 px-2 text-xs" :title="t('grid.formattedJson')" @click="toggleJsonFormatted">
                <Code2 class="h-3 w-3" />
                {{ t("grid.formattedJson") }}
              </Button>
              <Button v-if="detail.isEditable" variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.editValue')" @click="emit('edit')">
                <Pencil class="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.copyValue')" @click="copyCurrentValue">
                <Copy class="h-3 w-3" />
              </Button>
              <DropdownMenu v-if="canDownloadBinaryValue(detail)">
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.downloadBinaryValue')">
                    <Upload class="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="w-44">
                  <DropdownMenuItem v-for="mode in BINARY_CELL_DOWNLOAD_MODES" :key="mode" @click="downloadBinaryValue(detail, mode)">
                    {{ t(`grid.binaryDownload.${mode}`) }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <!-- Unsupported geometry values can arrive as a hex fallback that cannot be rendered. -->
              <Popover v-if="isGeometryColumnType(detail.type) && detail.value !== null && !isHexGeometry(detail.value as string)" v-model:open="geometryPreviewOpen">
                <PopoverTrigger as-child>
                  <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.geometryPreview')">
                    <Eye class="h-3 w-3" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent class="w-auto p-1.5" align="end">
                  <canvas v-show="geometryPreviewOpen" ref="geometryCanvas" width="400" height="280" class="block rounded" />
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <a v-if="detail.imagePreviewUrl" :href="detail.imagePreviewUrl" role="button" class="block max-h-72 overflow-hidden rounded border bg-muted/20" @click.prevent="openImagePreview(detail.imagePreviewUrl, detail.column)">
            <img :src="detail.imagePreviewUrl" :alt="detail.column" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="max-h-72 w-full object-contain" />
          </a>
          <div v-if="jsonView && detail.formattedJson" ref="jsonPreviewContainer" data-cell-detail-editor-root class="h-[44vh] min-h-60 overflow-hidden rounded border bg-muted/20 p-3" />
          <pre v-else class="dbx-data-grid-value-font max-h-[44vh] overflow-auto rounded border bg-muted/20 p-3 text-xs whitespace-pre-wrap break-words" :class="{ 'italic text-muted-foreground': detail.value === null }">{{ detail.rawValuePreview }}</pre>
          <div v-if="detail.isValuePreviewTruncated && !jsonView" class="text-[11px] text-muted-foreground">
            {{ t("grid.largeValuePreviewHint", { count: detail.rawValuePreview.length }) }}
          </div>
        </div>
      </div>

      <DialogFooter class="shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-wrap gap-2" />
        <Button variant="ghost" size="sm" class="h-7 text-xs" @click="copyColumnName">
          <Copy class="mr-1.5 h-3 w-3" />
          {{ t("grid.copyColumnName") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
