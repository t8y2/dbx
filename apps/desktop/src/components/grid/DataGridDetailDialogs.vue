<script setup lang="ts">
import { computed, ref } from "vue";
import { Copy, ListTree, Search, TableProperties } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { filterDataGridDetailFields, type DataGridCellDetail, type DataGridColumnDetail, type DataGridRowDetail } from "@/lib/dataGrid/dataGridDetail";

const { t } = useI18n();
const props = defineProps<{
  rowDetail: DataGridRowDetail | null;
  columnDetail: DataGridColumnDetail | null;
  typeColorClass: (type: string) => string;
  openImagePreview: (src: string, title: string) => void;
  copyRowDetailFieldValue: (field: DataGridCellDetail) => void;
  copyColumnDetailFieldValue: (field: DataGridCellDetail) => void;
  copyRowDetailJson: () => void;
  copyRowDetailTsv: () => void;
  copyColumnDetailJson: () => void;
  copyColumnDetailTsv: () => void;
  copyColumnDetailColumnName: () => void;
}>();

const rowOpen = defineModel<boolean>("rowOpen", { default: false });
const columnOpen = defineModel<boolean>("columnOpen", { default: false });
const rowSearch = ref("");
const columnSearch = ref("");
const filteredRowFields = computed(() => (props.rowDetail ? filterDataGridDetailFields(props.rowDetail.fields, rowSearch.value) : []));
const filteredColumnFields = computed(() => (props.columnDetail ? filterDataGridDetailFields(props.columnDetail.fields, columnSearch.value) : []));
</script>

<template>
  <Dialog v-model:open="rowOpen">
    <DialogContent v-if="rowDetail" class="sm:max-w-[960px] max-h-[85vh] flex flex-col overflow-hidden">
      <DialogHeader class="shrink-0 pr-8">
        <DialogTitle class="flex min-w-0 items-center gap-2 text-sm"
          ><ListTree class="h-4 w-4 shrink-0 text-muted-foreground" /><span class="min-w-0 truncate">{{ t("grid.rowDetailsFor", { row: rowDetail.rowNumber }) }}</span></DialogTitle
        >
      </DialogHeader>
      <div class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <span class="whitespace-nowrap">{{ t("grid.columnsCount", { count: rowDetail.fields.length }) }}</span>
        <div class="relative ml-auto w-56 max-w-full"><Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input v-model="rowSearch" :placeholder="t('grid.detailSearchPlaceholder')" class="h-7 pl-7 text-xs" /></div>
      </div>
      <div class="min-h-0 flex-1 overflow-auto rounded border">
        <table class="w-full min-w-[640px] text-xs">
          <thead class="sticky top-0 z-10 bg-muted text-muted-foreground">
            <tr class="border-b">
              <th class="w-16 px-3 py-2 text-left font-medium">{{ t("grid.fieldIndex") }}</th>
              <th class="w-56 px-3 py-2 text-left font-medium">{{ t("grid.columnName") }}</th>
              <th class="px-3 py-2 text-left font-medium">{{ t("grid.cellValue") }}</th>
              <th class="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="(field, index) in filteredRowFields" :key="`${field.colIndex}:${field.column}`" class="border-b align-top last:border-b-0">
              <td class="px-3 py-2 text-muted-foreground tabular-nums">{{ index + 1 }}</td>
              <td class="px-3 py-2">
                <div class="font-medium break-words">{{ field.column }}</div>
                <div :class="field.type ? typeColorClass(field.type) : 'text-muted-foreground'" class="mt-1 text-[11px]">{{ field.type || "-" }}</div>
                <div v-if="field.comment" class="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap">{{ field.comment }}</div>
              </td>
              <td class="w-full max-w-0 px-3 py-2">
                <div class="mb-1 text-[11px] text-muted-foreground">{{ field.value === null ? t("grid.nullValue") : t("grid.valueLength") }}: {{ field.value === null ? "true" : field.length }}</div>
                <a v-if="field.imagePreviewUrl" :href="field.imagePreviewUrl" role="button" class="mb-2 block max-h-48 overflow-hidden rounded border bg-muted/20" @click.prevent="openImagePreview(field.imagePreviewUrl, field.column)"
                  ><img :src="field.imagePreviewUrl" :alt="field.column" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="max-h-48 w-full object-contain"
                /></a>
                <pre class="dbx-data-grid-value-font max-h-44 overflow-auto rounded border bg-muted/20 p-2 text-xs whitespace-pre-wrap break-words" :class="{ 'italic text-muted-foreground': field.value === null }">{{ field.rawValuePreview }}</pre>
                <div v-if="field.isValuePreviewTruncated" class="mt-1 text-[11px] text-muted-foreground">{{ t("grid.largeValuePreviewHint", { count: field.rawValuePreview.length }) }}</div>
                <div v-if="field.formattedJson" class="mt-2 space-y-1">
                  <div class="text-muted-foreground">{{ t("grid.formattedJson") }}</div>
                  <pre class="dbx-data-grid-value-font max-h-44 overflow-auto rounded border bg-muted/20 p-2 text-xs whitespace-pre-wrap break-words">{{ field.formattedJson }}</pre>
                </div>
              </td>
              <td class="px-2 py-2">
                <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.copyValue')" @click="copyRowDetailFieldValue(field)"><Copy class="h-3 w-3" /></Button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="rowSearch && !filteredRowFields.length" class="px-3 py-6 text-center text-xs text-muted-foreground">{{ t("grid.detailSearchNoMatch") }}</div>
      </div>
      <DialogFooter class="shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
        ><div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyRowDetailJson"><Copy class="mr-1.5 h-3 w-3" />{{ t("grid.copyRow") }}</Button
          ><Button variant="outline" size="sm" class="h-7 text-xs" @click="copyRowDetailTsv"><Copy class="mr-1.5 h-3 w-3" />{{ t("grid.copyRowTsv") }}</Button>
        </div></DialogFooter
      >
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="columnOpen">
    <DialogContent v-if="columnDetail" class="sm:max-w-[900px] max-h-[85vh] flex flex-col overflow-hidden">
      <DialogHeader class="shrink-0 pr-8"
        ><DialogTitle class="flex min-w-0 items-center gap-2 text-sm"
          ><TableProperties class="h-4 w-4 shrink-0 text-muted-foreground" /><span class="min-w-0 truncate">{{ t("grid.columnDetailsFor", { column: columnDetail.column }) }}</span></DialogTitle
        ></DialogHeader
      >
      <div class="grid shrink-0 gap-3 rounded border bg-muted/20 p-3 text-xs sm:grid-cols-3">
        <div>
          <div class="text-muted-foreground">{{ t("grid.columnName") }}</div>
          <div class="font-medium break-all">{{ columnDetail.column }}</div>
        </div>
        <div>
          <div class="text-muted-foreground">{{ t("grid.columnType") }}</div>
          <div :class="columnDetail.type ? typeColorClass(columnDetail.type) : 'text-muted-foreground'">{{ columnDetail.type || "-" }}</div>
        </div>
        <div>
          <div class="text-muted-foreground">{{ t("grid.rowCount") }}</div>
          <div>{{ columnDetail.fields.length }}</div>
        </div>
        <div class="sm:col-span-3">
          <div class="text-muted-foreground">{{ t("grid.columnComment") }}</div>
          <div class="whitespace-pre-wrap break-words">{{ columnDetail.comment || t("grid.noComment") }}</div>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <span class="whitespace-nowrap">{{ t("grid.rowCount") }}: {{ columnDetail.fields.length }}</span>
        <div class="relative ml-auto w-56 max-w-full"><Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input v-model="columnSearch" :placeholder="t('grid.detailSearchPlaceholder')" class="h-7 pl-7 text-xs" /></div>
      </div>
      <div class="min-h-0 flex-1 overflow-auto rounded border">
        <table class="w-full min-w-[500px] text-xs">
          <thead class="sticky top-0 z-10 bg-muted text-muted-foreground">
            <tr class="border-b">
              <th class="w-24 px-3 py-2 text-left font-medium">{{ t("grid.rowNumber") }}</th>
              <th class="px-3 py-2 text-left font-medium">{{ t("grid.cellValue") }}</th>
              <th class="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in filteredColumnFields" :key="`${field.rowId}:${field.colIndex}`" class="border-b align-top last:border-b-0">
              <td class="px-3 py-2 tabular-nums">{{ field.rowNumber }}</td>
              <td class="w-full max-w-0 px-3 py-2">
                <div class="mb-1 text-[11px] text-muted-foreground">{{ field.value === null ? t("grid.nullValue") : t("grid.valueLength") }}: {{ field.value === null ? "true" : field.length }}</div>
                <a v-if="field.imagePreviewUrl" :href="field.imagePreviewUrl" role="button" class="mb-2 block max-h-40 overflow-hidden rounded border bg-muted/20" @click.prevent="openImagePreview(field.imagePreviewUrl, field.column)"
                  ><img :src="field.imagePreviewUrl" :alt="field.column" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="max-h-40 w-full object-contain"
                /></a>
                <pre class="dbx-data-grid-value-font max-h-36 overflow-auto rounded border bg-muted/20 p-2 text-xs whitespace-pre-wrap break-words" :class="{ 'italic text-muted-foreground': field.value === null }">{{ field.rawValuePreview }}</pre>
                <div v-if="field.isValuePreviewTruncated" class="mt-1 text-[11px] text-muted-foreground">{{ t("grid.largeValuePreviewHint", { count: field.rawValuePreview.length }) }}</div>
                <div v-if="field.formattedJson" class="mt-2 space-y-1">
                  <div class="text-muted-foreground">{{ t("grid.formattedJson") }}</div>
                  <pre class="dbx-data-grid-value-font max-h-36 overflow-auto rounded border bg-muted/20 p-2 text-xs whitespace-pre-wrap break-words">{{ field.formattedJson }}</pre>
                </div>
              </td>
              <td class="px-2 py-2">
                <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.copyValue')" @click="copyColumnDetailFieldValue(field)"><Copy class="h-3 w-3" /></Button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="columnSearch && !filteredColumnFields.length" class="px-3 py-6 text-center text-xs text-muted-foreground">{{ t("grid.detailSearchNoMatch") }}</div>
      </div>
      <DialogFooter class="shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
        ><div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyColumnDetailJson"><Copy class="mr-1.5 h-3 w-3" />{{ t("grid.copyColumnValues") }}</Button
          ><Button variant="outline" size="sm" class="h-7 text-xs" @click="copyColumnDetailTsv"><Copy class="mr-1.5 h-3 w-3" />{{ t("grid.copyColumnTsv") }}</Button>
        </div>
        <Button variant="ghost" size="sm" class="h-7 text-xs" @click="copyColumnDetailColumnName"><Copy class="mr-1.5 h-3 w-3" />{{ t("grid.copyColumnName") }}</Button></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>
