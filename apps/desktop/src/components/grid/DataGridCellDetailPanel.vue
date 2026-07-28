<script setup lang="ts">
import { toRef } from "vue";
import { Code2, Copy, Eye, Pencil, Upload, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TabsContent } from "@/components/ui/tabs";
import TemporalCellEditor from "@/components/grid/TemporalCellEditor.vue";
import { useDataGridCellDetail } from "@/composables/useDataGridCellDetail";
import { BINARY_CELL_DOWNLOAD_MODES, type BinaryCellDownloadMode } from "@/lib/dataGrid/binaryCellDownload";
import { isGeometryColumnType } from "@/lib/dataGrid/cellDetailPresentation";
import { isHexGeometry } from "@/lib/dataGrid/geometryPreview";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";
import type { TemporalCellEditorConfig } from "@/lib/dataGrid/dataGridTemporalEditor";

const { t } = useI18n();

const props = defineProps<{
  detail: DataGridCellDetail;
  panelIsBottom: boolean;
  metadataCollapsed: boolean;
  valueFillsHeight: boolean;
  editing: boolean;
  editorStyle?: Record<string, string>;
  temporalEditorConfig?: TemporalCellEditorConfig;
  sideJsonView: boolean;
  showCompactJson: boolean;
  canCompactJson: boolean;
  typeColorClass: (type: string) => string;
  canDownloadBinaryValue: (detail: DataGridCellDetail | null) => boolean;
  downloadBinaryValue: (detail: DataGridCellDetail | null, mode: BinaryCellDownloadMode) => void | Promise<void>;
  openImagePreview: (src: string, title: string) => void;
  canCopySqlCondition: () => boolean;
}>();

const detailEditValue = defineModel<string>("value", { default: "" });

const emit = defineEmits<{
  startEdit: [];
  compactJson: [];
  toggleFormatted: [];
  copyValue: [];
  commit: [];
  cancel: [];
  setNull: [];
  copyColumnName: [];
  copySqlCondition: [];
}>();

const { geometryPreviewOpen, geometryCanvas, detailsEditorContainer, sideJsonPreviewContainer, openSearch } = useDataGridCellDetail({ detail: toRef(props, "detail"), editValue: detailEditValue, onCancel: () => emit("cancel") });
void geometryCanvas;
void detailsEditorContainer;
void sideJsonPreviewContainer;

defineExpose({ openSearch });
</script>

<template>
  <TabsContent value="details" class="m-0 min-h-0 flex-1 flex flex-col">
    <div data-native-clipboard class="flex-1 min-h-0 overflow-auto px-3 pt-3 text-xs" :class="[valueFillsHeight ? 'flex flex-col gap-3' : 'space-y-3', editing && !panelIsBottom ? 'pb-1' : 'pb-3']">
      <div v-if="panelIsBottom && !metadataCollapsed" class="grid grid-cols-[minmax(180px,1.6fr)_repeat(4,minmax(74px,0.55fr))_minmax(160px,1fr)] gap-3 rounded border bg-muted/20 p-2">
        <div class="min-w-0 space-y-1">
          <div class="text-muted-foreground">{{ t("grid.columnName") }}</div>
          <div class="truncate font-medium" :title="detail.column">{{ detail.column }}</div>
        </div>
        <div class="space-y-1">
          <div class="text-muted-foreground">{{ t("grid.rowNumber") }}</div>
          <div>{{ detail.rowNumber }}</div>
        </div>
        <div class="min-w-0 space-y-1">
          <div class="text-muted-foreground">{{ t("grid.columnType") }}</div>
          <div class="truncate" :class="detail.type ? typeColorClass(detail.type) : 'text-muted-foreground'" :title="detail.type || '-'">{{ detail.type || "-" }}</div>
        </div>
        <div class="space-y-1">
          <div class="text-muted-foreground">{{ t("grid.nullValue") }}</div>
          <div>{{ detail.value === null ? "true" : "false" }}</div>
        </div>
        <div class="space-y-1">
          <div class="text-muted-foreground">{{ t("grid.valueLength") }}</div>
          <div>{{ detail.length }}</div>
        </div>
        <div class="min-w-0 space-y-1">
          <div class="text-muted-foreground">{{ t("grid.columnComment") }}</div>
          <div class="truncate" :title="detail.comment || t('grid.noComment')">{{ detail.comment || t("grid.noComment") }}</div>
        </div>
      </div>
      <template v-else-if="!metadataCollapsed && !editing">
        <div class="space-y-1">
          <div class="text-muted-foreground">{{ t("grid.columnName") }}</div>
          <div class="font-medium break-all">{{ detail.column }}</div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.rowNumber") }}</div>
            <div>{{ detail.rowNumber }}</div>
          </div>
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.columnType") }}</div>
            <div :class="detail.type ? typeColorClass(detail.type) : 'text-muted-foreground'">{{ detail.type || "-" }}</div>
          </div>
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.nullValue") }}</div>
            <div>{{ detail.value === null ? "true" : "false" }}</div>
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
      </template>

      <div class="space-y-1" :class="[{ 'min-h-0 flex flex-col': valueFillsHeight }, valueFillsHeight && !(detail.imagePreviewUrl && !editing) ? 'flex-1' : '', detail.imagePreviewUrl && !editing ? 'shrink-0' : '']">
        <div class="flex min-h-5 items-center justify-between gap-2">
          <div class="text-muted-foreground">{{ t("grid.cellValue") }}</div>
          <div class="flex items-center gap-1">
            <Button v-if="showCompactJson" variant="ghost" size="sm" class="h-5 gap-1 px-1.5 text-xs" :disabled="!canCompactJson" :title="t('grid.compactJson')" @click="emit('compactJson')"><Code2 class="h-3 w-3" />{{ t("grid.compactJson") }}</Button>
            <Button v-if="!editing && detail.formattedJson" :variant="sideJsonView ? 'secondary' : 'ghost'" size="sm" class="h-5 gap-1 px-1.5 text-xs" :title="t('grid.formattedJson')" @click="emit('toggleFormatted')"><Code2 class="h-3 w-3" />{{ t("grid.formattedJson") }}</Button>
            <Button v-if="!editing && detail.isEditable" variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.editValue')" @click="emit('startEdit')"><Pencil class="h-3 w-3" /></Button>
            <Button v-if="!editing" variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.copyValue')" @click="emit('copyValue')"><Copy class="h-3 w-3" /></Button>
            <DropdownMenu v-if="!editing && canDownloadBinaryValue(detail)"
              ><DropdownMenuTrigger as-child
                ><Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.downloadBinaryValue')"><Upload class="h-3 w-3" /></Button></DropdownMenuTrigger
              ><DropdownMenuContent align="end" class="w-44"
                ><DropdownMenuItem v-for="mode in BINARY_CELL_DOWNLOAD_MODES" :key="mode" @click="downloadBinaryValue(detail, mode)">{{ t(`grid.binaryDownload.${mode}`) }}</DropdownMenuItem></DropdownMenuContent
              ></DropdownMenu
            >
            <Popover v-if="isGeometryColumnType(detail.type) && detail.value !== null && !editing && !isHexGeometry(detail.value as string)" v-model:open="geometryPreviewOpen"
              ><PopoverTrigger as-child
                ><Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.geometryPreview')"><Eye class="h-3 w-3" /></Button></PopoverTrigger
              ><PopoverContent class="w-auto p-1.5" align="end"><canvas v-show="geometryPreviewOpen" ref="geometryCanvas" width="400" height="280" class="block rounded" /></PopoverContent
            ></Popover>
          </div>
        </div>
        <div v-if="detail.imagePreviewUrl && !editing" class="shrink-0 space-y-1.5">
          <div class="text-muted-foreground">{{ t("grid.imagePreview") }}</div>
          <a :href="detail.imagePreviewUrl" role="button" class="flex overflow-hidden rounded border bg-muted/20" :class="panelIsBottom ? 'max-h-28' : 'max-h-40'" @click.prevent="openImagePreview(detail.imagePreviewUrl, detail.column)"
            ><img :src="detail.imagePreviewUrl" :alt="detail.column" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="max-h-full w-full object-contain"
          /></a>
        </div>
        <template v-if="editing"
          ><div class="dbx-data-grid-value-font min-h-0 flex-1" :style="editorStyle">
            <TemporalCellEditor v-if="temporalEditorConfig" v-model="detailEditValue" :kind="temporalEditorConfig.kind" :fraction-precision="temporalEditorConfig.fractionPrecision" variant="inline" :commit-on-close="false" @cancel="emit('cancel')" @commit="emit('commit')" />
            <div v-else ref="detailsEditorContainer" data-cell-detail-editor-root class="min-h-0 h-full w-full rounded border overflow-hidden" />
          </div>
          <div v-if="!panelIsBottom" class="flex shrink-0 gap-1 py-0.5">
            <Button size="sm" class="h-6 text-xs" @click="emit('commit')">{{ t("dangerDialog.confirm") }}</Button
            ><Button variant="outline" size="sm" class="h-6 text-xs" @click="emit('cancel')">{{ t("dangerDialog.cancel") }}</Button>
          </div></template
        >
        <div
          v-else-if="detail.formattedJson"
          ref="sideJsonPreviewContainer"
          data-cell-detail-editor-root
          class="overflow-hidden rounded border bg-muted/20 p-2"
          :class="[{ 'cursor-text': detail.isEditable }, valueFillsHeight ? 'min-h-0 flex-1' : 'h-72 max-h-[42vh]']"
          @dblclick.capture="emit('startEdit')"
        />
        <pre
          v-else
          class="dbx-data-grid-value-font overflow-auto rounded border bg-muted/20 p-2 text-xs whitespace-pre-wrap break-words cursor-pointer hover:border-primary/50"
          :class="[{ 'cursor-text': detail.isEditable }, panelIsBottom && detail.imagePreviewUrl ? 'min-h-24 max-h-32 shrink-0' : '', valueFillsHeight && !detail.imagePreviewUrl ? 'min-h-0 flex-1' : '']"
          @dblclick="emit('startEdit')"
          >{{ detail.rawValuePreview }}</pre
        >
        <div v-if="detail.isValuePreviewTruncated && !sideJsonView" class="text-[11px] text-muted-foreground">{{ t("grid.largeValuePreviewHint", { count: detail.rawValuePreview.length }) }}</div>
      </div>
    </div>
    <div class="border-t flex gap-1 overflow-hidden bg-background p-1.5" :class="panelIsBottom ? 'shrink-0 items-center' : 'shrink-0 flex-col'">
      <div v-if="editing && panelIsBottom" class="flex shrink-0 gap-1 mr-auto">
        <Button size="sm" class="h-6 text-xs" @click="emit('commit')">{{ t("dangerDialog.confirm") }}</Button
        ><Button variant="outline" size="sm" class="h-6 text-xs" @click="emit('cancel')">{{ t("dangerDialog.cancel") }}</Button>
      </div>
      <div class="flex gap-1" :class="panelIsBottom ? 'ml-auto shrink-0 justify-end' : 'flex-col'">
        <Button v-if="detail.isEditable && detail.value !== null" variant="ghost" size="sm" class="h-6 justify-start text-xs" @click="emit('setNull')"><X class="w-3 h-3 mr-2" />{{ t("grid.setNull") }}</Button
        ><Button variant="ghost" size="sm" class="h-6 justify-start text-xs" @click="emit('copyColumnName')"><Copy class="w-3 h-3 mr-2" />{{ t("grid.copyColumnName") }}</Button
        ><Button variant="ghost" size="sm" class="h-6 justify-start text-xs" :disabled="!canCopySqlCondition()" @click="emit('copySqlCondition')"><Code2 class="w-3 h-3 mr-2" />{{ t("grid.copySqlCondition") }}</Button>
      </div>
    </div>
  </TabsContent>
</template>
