<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, Filter, LoaderCircle, Plus, RefreshCcw, Trash2, Upload, X } from "@lucide/vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/composables/useToast";
import { buildDocumentFilterCondition, currentDocumentFilterJson, currentDocumentSortJson, documentFilterModeNeedsValue, documentFilterModeOptions, documentStoreProviderFor, type DocumentFilterMode, type DocumentFilterRule } from "@/lib/app/documentStoreProvider";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { downloadBinaryCellPayload, type BinaryCellDownloadPayload } from "@/lib/dataGrid/binaryCellDownload";
import { normalizeResultPageSize, resultPageSizeMenuOptions } from "@/lib/dataGrid/paginationPageSize";
import { buildGridFsFilesStructuredFilter, createGridFsFileFilterRule, currentGridFsFileSortDirection, gridFsFileFieldDisplayOption, gridFsFileFieldDisplayOptions, gridFsFilesQueryPreview } from "@/lib/document/gridFsBrowser";
import { buildGridFsDownloadArchive, defaultGridFsArchiveFileName, formatGridFsUploadDate } from "@/lib/document/gridfsFiles";
import { clampGridFsPage, gridFsTotalPages, paginateGridFsItems } from "@/lib/document/gridfsPagination";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";

const props = defineProps<{
  connectionId: string;
  database: string;
  bucket: string;
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();

const loading = ref(false);
const uploading = ref(false);
const downloading = ref(false);
const deleting = ref(false);
const error = ref("");
const files = ref<Awaited<ReturnType<typeof api.documentListGridFsFiles>>>([]);
const selectedFileId = ref("");
const checkedFileIds = ref<Set<string>>(new Set());
const showDeleteConfirm = ref(false);
const filterInput = ref("");
const sortInput = ref("");
const filterBuilderOpen = ref(false);
const filterRules = ref<DocumentFilterRule[]>([createGridFsFileFilterRule(uuid())]);
const appliedStructuredFilter = ref<Record<string, unknown> | null>(null);
const page = ref(0);
const pageSize = ref(normalizeResultPageSize(settingsStore.editorSettings.pageSize));

const totalBytes = computed(() => files.value.reduce((sum, file) => sum + (file.length || 0), 0));
const totalFileCount = computed(() => files.value.length);
const totalPages = computed(() => gridFsTotalPages(totalFileCount.value, pageSize.value));
const pagedFiles = computed(() => paginateGridFsItems(files.value, page.value, pageSize.value));
const pageSizeOptions = computed(() => resultPageSizeMenuOptions(pageSize.value));
const selectedFile = computed(() => files.value.find((file) => file.id === selectedFileId.value) || null);
const checkedFiles = computed(() => files.value.filter((file) => checkedFileIds.value.has(file.id)));
const checkedFileCount = computed(() => checkedFiles.value.length);
const canToggleAllFiles = computed(() => files.value.length > 0);
const allFilesChecked = computed(() => files.value.length > 0 && checkedFileIds.value.size === files.value.length);
const partiallyChecked = computed(() => checkedFileIds.value.size > 0 && checkedFileIds.value.size < files.value.length);
const downloadTargets = computed(() => (checkedFileCount.value > 0 ? checkedFiles.value : selectedFile.value ? [selectedFile.value] : []));
const downloadButtonLabel = computed(() => (checkedFileCount.value > 0 ? t("gridfsBrowser.downloadSelected") : t("gridfsBrowser.downloadFile")));
const selectedMetadata = computed(() => (selectedFile.value?.metadata ? JSON.stringify(selectedFile.value.metadata, null, 2) : ""));
const isReadonly = computed(() => connectionStore.getConfig(props.connectionId)?.read_only ?? false);
const mongoProvider = documentStoreProviderFor("mongodb");
const activeStructuredRuleCount = computed(() => {
  if (!appliedStructuredFilter.value) return 0;
  return filterRules.value.filter((rule) => !!buildDocumentFilterCondition(rule, { kind: "mongodb" })).length;
});
const filterBuilderActive = computed(() => !!appliedStructuredFilter.value);
const filesQueryPreview = computed(() => {
  let filter = "{}";
  let sort: string | undefined;
  try {
    filter = currentFilesFilter() || "{}";
    sort = currentDocumentSortJson(sortInput.value);
  } catch {
    filter = filterInput.value.trim() || "{}";
    sort = sortInput.value.trim() || undefined;
  }
  return gridFsFilesQueryPreview({
    bucket: props.bucket,
    filterJson: filter,
    sortJson: sort,
  });
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function displayName(file: (typeof files.value)[number]): string {
  return file.filename || file.id;
}

function gridFsFileFieldLabel(fieldName: string): string {
  const option = gridFsFileFieldDisplayOption(fieldName);
  if (!option) return fieldName;
  if (option.label !== undefined) return option.label;
  if (option.labelKey !== undefined) return t(option.labelKey);
  return fieldName;
}

function formattedUploadDate(value?: string | null): string {
  return formatGridFsUploadDate(value);
}

function currentFilesFilter(): string | undefined {
  return currentDocumentFilterJson(filterInput.value, appliedStructuredFilter.value, "mongodb");
}

function ensureFilterRule() {
  if (filterRules.value.length === 0) {
    filterRules.value = [createGridFsFileFilterRule(uuid())];
  }
}

function addFilterRule() {
  ensureFilterRule();
  filterRules.value = [...filterRules.value, createGridFsFileFilterRule(uuid())];
}

function removeFilterRule(ruleId: string) {
  filterRules.value = filterRules.value.filter((rule) => rule.id !== ruleId);
  if (filterRules.value.length === 0) {
    appliedStructuredFilter.value = null;
  }
}

function updateFilterRule(ruleId: string, patch: Partial<DocumentFilterRule>) {
  filterRules.value = filterRules.value.map((rule) => {
    if (rule.id !== ruleId) return rule;
    const next = { ...rule, ...patch };
    if (!documentFilterModeNeedsValue(next.mode)) next.rawValue = "";
    return next;
  });
}

function resetFilterBuilder() {
  appliedStructuredFilter.value = null;
  filterRules.value = [createGridFsFileFilterRule(uuid())];
}

function isFileChecked(fileId: string): boolean {
  return checkedFileIds.value.has(fileId);
}

function setFileChecked(fileId: string, checked: boolean) {
  const next = new Set(checkedFileIds.value);
  if (checked) next.add(fileId);
  else next.delete(fileId);
  checkedFileIds.value = next;
}

function toggleAllFiles(checked: boolean) {
  checkedFileIds.value = checked ? new Set(files.value.map((file) => file.id)) : new Set();
}

function ensurePageInRange() {
  page.value = clampGridFsPage(page.value, totalFileCount.value, pageSize.value);
}

function resetToFirstPage() {
  page.value = 0;
}

function prevPage() {
  if (page.value <= 0) return;
  page.value -= 1;
}

function nextPage() {
  if (page.value + 1 >= totalPages.value) return;
  page.value += 1;
}

function updatePageSize(nextValue: unknown) {
  const normalized = normalizeResultPageSize(nextValue, pageSize.value);
  pageSize.value = normalized;
  resetToFirstPage();
  settingsStore.updateEditorSettings({ pageSize: normalized });
}

async function loadFiles() {
  loading.value = true;
  error.value = "";
  try {
    const nextFiles = await api.documentListGridFsFiles(props.connectionId, props.database, props.bucket, currentFilesFilter(), currentDocumentSortJson(sortInput.value));
    files.value = nextFiles;
    checkedFileIds.value = new Set(nextFiles.filter((file) => checkedFileIds.value.has(file.id)).map((file) => file.id));
    if (selectedFileId.value && !nextFiles.some((file) => file.id === selectedFileId.value)) {
      selectedFileId.value = "";
    }
    ensurePageInRange();
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function applyQuery() {
  resetToFirstPage();
  void loadFiles();
}

type SortDirection = "asc" | "desc" | null;

function currentSortDirection(column: string): SortDirection {
  const direction = currentGridFsFileSortDirection(sortInput.value, column);
  return direction === "none" ? null : direction;
}

function toggleSortForColumn(column: string) {
  const current = currentSortDirection(column);
  const nextDirection: SortDirection = current === "asc" ? "desc" : current === "desc" ? null : "asc";
  sortInput.value = mongoProvider.sortInputForColumn(column, nextDirection);
  resetToFirstPage();
  void loadFiles();
}

function sortIconForColumn(column: string) {
  const direction = currentSortDirection(column);
  return direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ArrowUpDown;
}

function sortIconClass(column: string): string {
  return currentSortDirection(column) ? "text-foreground" : "text-muted-foreground/60";
}

function applyStructuredFilters() {
  appliedStructuredFilter.value = buildGridFsFilesStructuredFilter(filterRules.value);
  filterBuilderOpen.value = false;
  resetToFirstPage();
  void loadFiles();
}

function clearAllFilters() {
  filterInput.value = "";
  appliedStructuredFilter.value = null;
  filterRules.value = [createGridFsFileFilterRule(uuid())];
  resetToFirstPage();
  void loadFiles();
}

async function downloadSingleFile(file: (typeof files.value)[number]) {
  const bytes = await api.documentDownloadGridFsFile(props.connectionId, props.database, props.bucket, file.id);
  const payload: BinaryCellDownloadPayload = {
    data: bytes,
    mimeType: file.contentType || "application/octet-stream",
    extension: file.filename?.includes(".") ? file.filename.split(".").pop() || "bin" : "bin",
  };
  return downloadBinaryCellPayload(payload, displayName(file));
}

async function downloadMultipleFiles(selectedFiles: typeof files.value) {
  const archiveEntries: Array<{ id: string; filename?: string; data: Uint8Array }> = [];
  for (const file of selectedFiles) {
    archiveEntries.push({
      id: file.id,
      filename: file.filename,
      data: await api.documentDownloadGridFsFile(props.connectionId, props.database, props.bucket, file.id),
    });
  }
  const payload: BinaryCellDownloadPayload = {
    data: buildGridFsDownloadArchive(archiveEntries),
    mimeType: "application/zip",
    extension: "zip",
  };
  return downloadBinaryCellPayload(payload, defaultGridFsArchiveFileName(props.bucket));
}

async function downloadSpecificFile(file: (typeof files.value)[number]) {
  if (downloading.value) return;
  downloading.value = true;
  try {
    const result = await downloadSingleFile(file);
    if (result.kind === "saved") {
      toast(t("grid.exported"), 2500);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    downloading.value = false;
  }
}

async function downloadCurrentSelection() {
  if (downloading.value || downloadTargets.value.length === 0) return;
  downloading.value = true;
  try {
    const result = downloadTargets.value.length === 1 ? await downloadSingleFile(downloadTargets.value[0]) : await downloadMultipleFiles(downloadTargets.value);
    if (result.kind === "saved") {
      toast(t("grid.exported"), 2500);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    downloading.value = false;
  }
}

async function pickUploadFile(): Promise<{ name: string; data: Uint8Array; contentType?: string } | null> {
  if (isTauriRuntime()) {
    const [{ open }, fs] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const selected = await open({ multiple: false });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path || typeof path !== "string") return null;
    const data = await fs.readFile(path);
    const name = path.split(/[\\/]/).pop() || "file";
    return { name, data };
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const data = new Uint8Array(await file.arrayBuffer());
        resolve({ name: file.name, data, contentType: file.type || undefined });
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

async function uploadFile() {
  if (uploading.value) return;
  try {
    const selected = await pickUploadFile();
    if (!selected) return;
    uploading.value = true;
    const fileId = await api.documentUploadGridFsFile(props.connectionId, props.database, props.bucket, selected.name, selected.data, selected.contentType);
    await loadFiles();
    selectedFileId.value = fileId;
    toast(t("gridfsBrowser.fileUploaded", { fileName: selected.name }), 2500);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    uploading.value = false;
  }
}

async function deleteSelectedFile() {
  const file = selectedFile.value;
  if (!file || deleting.value) return;
  deleting.value = true;
  try {
    await api.documentDeleteGridFsFile(props.connectionId, props.database, props.bucket, file.id);
    showDeleteConfirm.value = false;
    selectedFileId.value = "";
    setFileChecked(file.id, false);
    await loadFiles();
    toast(t("gridfsBrowser.fileDeleted", { fileName: displayName(file) }), 2500);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    deleting.value = false;
  }
}

onMounted(() => {
  void loadFiles();
});

watch(
  () => settingsStore.editorSettings.pageSize,
  (value) => {
    pageSize.value = normalizeResultPageSize(value, pageSize.value);
    ensurePageInRange();
  },
);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="border-b border-border px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold">{{ database }}.{{ bucket }}</div>
          <div class="text-xs text-muted-foreground">
            {{ totalFileCount }} {{ t("gridfsBrowser.fileCount") }} / {{ formatBytes(totalBytes) }}
            <span v-if="checkedFileCount > 0"> / {{ t("gridfsBrowser.selectedCount", { count: checkedFileCount }) }}</span>
          </div>
        </div>
        <div v-if="totalFileCount > 0" class="flex items-center gap-1 text-xs text-muted-foreground">
          <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="page <= 0" @click="prevPage">
            <ChevronLeft class="h-3.5 w-3.5" />
          </Button>
          <span class="tabular-nums">{{ page + 1 }} / {{ totalPages }}</span>
          <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="page + 1 >= totalPages" @click="nextPage">
            <ChevronRight class="h-3.5 w-3.5" />
          </Button>
          <Select :model-value="String(pageSize)" @update:model-value="(value) => updatePageSize(value)">
            <SelectTrigger class="h-7 w-[106px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem v-for="size in pageSizeOptions" :key="size" :value="String(size)"> {{ size }}{{ t("grid.rowsPerPageShort") }} </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" class="h-8 gap-1.5" :disabled="isReadonly || uploading" @click="uploadFile">
            <Upload class="h-3.5 w-3.5" />
            {{ t("gridfsBrowser.uploadFile") }}
          </Button>
          <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="downloadTargets.length === 0 || downloading" @click="downloadCurrentSelection">
            <LoaderCircle v-if="downloading" class="h-3.5 w-3.5 animate-spin" />
            <Download v-else class="h-3.5 w-3.5" />
            {{ downloadButtonLabel }}
          </Button>
          <Button variant="destructive" size="sm" class="h-8 gap-1.5" :disabled="isReadonly || !selectedFile || deleting" @click="showDeleteConfirm = true">
            <Trash2 class="h-3.5 w-3.5" />
            {{ t("gridfsBrowser.deleteFile") }}
          </Button>
          <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="loading" @click="loadFiles">
            <RefreshCcw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
            {{ t("grid.refresh") }}
          </Button>
        </div>
      </div>
      <div class="mt-3 overflow-hidden rounded-xl border border-border/70 bg-background/80 shadow-xs">
        <div class="flex flex-col md:flex-row">
          <div class="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5">
            <Popover v-model:open="filterBuilderOpen">
              <PopoverTrigger as-child>
                <button
                  type="button"
                  class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-[11px] transition-colors"
                  :class="filterBuilderActive || filterInput.trim() ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground'"
                  @click="ensureFilterRule"
                >
                  <Filter class="h-3.5 w-3.5" />
                  <span v-if="activeStructuredRuleCount" class="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-none text-primary-foreground">
                    {{ activeStructuredRuleCount }}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-[420px] max-w-[calc(100vw-24px)] gap-3 p-3" @click.stop @keydown.stop>
                <div class="flex items-center justify-between gap-3">
                  <div class="text-xs font-medium text-foreground">{{ t("grid.filter") }}</div>
                  <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="addFilterRule">
                    <Plus class="mr-1 h-3.5 w-3.5" />
                    {{ t("grid.filterBuilderAddRule") }}
                  </Button>
                </div>

                <div v-if="filterRules.length" class="space-y-2">
                  <template v-for="(rule, index) in filterRules" :key="rule.id">
                    <div v-if="index > 0" class="flex justify-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-6 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                        @click="
                          updateFilterRule(rule.id, {
                            conjunction: rule.conjunction === 'AND' ? 'OR' : 'AND',
                          })
                        "
                      >
                        {{ rule.conjunction }}
                      </Button>
                    </div>
                    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)_minmax(0,1fr)_auto] items-center gap-1.5">
                      <Select :model-value="rule.fieldName" @update:model-value="(value: any) => updateFilterRule(rule.id, { fieldName: String(value) })">
                        <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                          <SelectValue :placeholder="t('grid.filterBuilderColumn')" />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          <SelectItem v-for="option in gridFsFileFieldDisplayOptions" :key="option.fieldName" :value="option.fieldName">
                            {{ gridFsFileFieldLabel(option.fieldName) }}
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <Select :model-value="rule.mode" @update:model-value="(value: any) => updateFilterRule(rule.id, { mode: value as DocumentFilterMode })">
                        <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          <SelectItem v-for="option in documentFilterModeOptions" :key="option.value" :value="option.value">
                            {{ t(option.labelKey) }}
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <Input
                        v-if="documentFilterModeNeedsValue(rule.mode)"
                        :model-value="rule.rawValue"
                        class="h-8 min-w-0 text-xs"
                        :placeholder="t('grid.filterBuilderValue')"
                        @update:model-value="(value) => updateFilterRule(rule.id, { rawValue: String(value ?? '') })"
                        @keydown.enter.prevent="applyStructuredFilters"
                      />
                      <div v-else class="flex h-8 min-w-0 items-center overflow-hidden rounded-md border border-dashed px-2 text-xs text-muted-foreground">
                        <span class="truncate">{{ t("grid.filterBuilderNoValue") }}</span>
                      </div>

                      <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" :disabled="filterRules.length === 1" @click="removeFilterRule(rule.id)">
                        <Trash2 class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </template>
                </div>
                <div v-else class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  {{ t("grid.filterBuilderEmpty") }}
                </div>

                <div class="flex items-center justify-between gap-2 pt-1">
                  <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="clearAllFilters">
                    {{ t("grid.clearFilter") }}
                  </Button>
                  <div class="flex items-center gap-2">
                    <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="resetFilterBuilder">
                      {{ t("grid.resetFilterBuilder") }}
                    </Button>
                    <Button size="sm" class="h-8 px-3 text-xs" @click="applyStructuredFilters">
                      {{ t("grid.applyFilter") }}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <span class="shrink-0 text-xs font-medium text-blue-600 dark:text-blue-400">{{ mongoProvider.filterInputLabel }}</span>
            <input v-model="filterInput" autocapitalize="off" autocorrect="off" spellcheck="false" class="h-7 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/60" placeholder="{}" @keydown.enter="applyQuery" />
            <button
              v-if="filterInput.trim()"
              class="shrink-0 text-muted-foreground hover:text-foreground"
              @click="
                filterInput = '';
                applyQuery();
              "
            >
              <X class="h-3.5 w-3.5" />
            </button>
          </div>
          <div class="h-px bg-border/70 md:h-auto md:w-px" />
          <div class="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5">
            <span class="shrink-0 text-xs font-medium text-orange-600 dark:text-orange-400">{{ mongoProvider.sortInputLabel }}</span>
            <input v-model="sortInput" autocapitalize="off" autocorrect="off" spellcheck="false" class="h-7 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/60" placeholder='{"uploadDate":-1}' @keydown.enter="applyQuery" />
            <button
              v-if="sortInput.trim()"
              class="shrink-0 text-muted-foreground hover:text-foreground"
              @click="
                sortInput = '';
                applyQuery();
              "
            >
              <X class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div class="border-t border-border/60 px-3 py-1.5">
          <div class="truncate font-mono text-[11px] text-muted-foreground" :title="filesQueryPreview">
            {{ filesQueryPreview }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="error" class="px-4 py-3 text-sm text-destructive">
      {{ error }}
    </div>

    <div v-else-if="loading && files.length === 0" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {{ t("executionSummary.executing") }}
    </div>

    <div v-else-if="files.length === 0" class="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
      {{ t("gridfsBrowser.emptyFiles") }}
    </div>

    <div v-else class="min-h-0 flex flex-1 flex-col overflow-hidden xl:flex-row xl:divide-x xl:divide-border">
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="min-w-full border-collapse text-[13px]">
          <thead class="sticky top-0 z-10 bg-background">
            <tr class="border-b border-border text-left text-xs text-muted-foreground">
              <th class="w-11 px-3 py-2 font-medium">
                <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="allFilesChecked" :indeterminate="partiallyChecked" :disabled="!canToggleAllFiles" @click.stop @change="toggleAllFiles(($event.target as HTMLInputElement).checked)" />
              </th>
              <th class="min-w-[320px] px-4 py-2 font-medium">
                <button type="button" class="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground" @click="toggleSortForColumn('filename')">
                  <span>{{ gridFsFileFieldLabel("filename") }}</span>
                  <component :is="sortIconForColumn('filename')" class="h-3.5 w-3.5" :class="sortIconClass('filename')" />
                </button>
              </th>
              <th class="min-w-[180px] px-4 py-2 font-medium">
                <button type="button" class="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground" @click="toggleSortForColumn('_id')">
                  <span>{{ gridFsFileFieldLabel("_id") }}</span>
                  <component :is="sortIconForColumn('_id')" class="h-3.5 w-3.5" :class="sortIconClass('_id')" />
                </button>
              </th>
              <th class="min-w-[96px] px-4 py-2 font-medium">
                <button type="button" class="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground" @click="toggleSortForColumn('length')">
                  <span>{{ gridFsFileFieldLabel("length") }}</span>
                  <component :is="sortIconForColumn('length')" class="h-3.5 w-3.5" :class="sortIconClass('length')" />
                </button>
              </th>
              <th class="min-w-[96px] px-4 py-2 font-medium">
                <button type="button" class="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground" @click="toggleSortForColumn('chunkSize')">
                  <span>{{ gridFsFileFieldLabel("chunkSize") }}</span>
                  <component :is="sortIconForColumn('chunkSize')" class="h-3.5 w-3.5" :class="sortIconClass('chunkSize')" />
                </button>
              </th>
              <th class="min-w-[158px] px-4 py-2 font-medium">
                <button type="button" class="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground" @click="toggleSortForColumn('uploadDate')">
                  <span>{{ gridFsFileFieldLabel("uploadDate") }}</span>
                  <component :is="sortIconForColumn('uploadDate')" class="h-3.5 w-3.5" :class="sortIconClass('uploadDate')" />
                </button>
              </th>
              <th class="min-w-[104px] px-4 py-2 font-medium">
                <button type="button" class="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground" @click="toggleSortForColumn('contentType')">
                  <span>{{ gridFsFileFieldLabel("contentType") }}</span>
                  <component :is="sortIconForColumn('contentType')" class="h-3.5 w-3.5" :class="sortIconClass('contentType')" />
                </button>
              </th>
              <th class="min-w-[220px] px-4 py-2 font-medium">
                <button type="button" class="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground" @click="toggleSortForColumn('md5')">
                  <span>{{ gridFsFileFieldLabel("md5") }}</span>
                  <component :is="sortIconForColumn('md5')" class="h-3.5 w-3.5" :class="sortIconClass('md5')" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="file in pagedFiles"
              :key="file.id"
              class="cursor-pointer border-b border-border/60 transition-colors hover:bg-muted/40"
              :class="{
                'bg-accent/45': selectedFileId === file.id,
                'bg-muted/35': selectedFileId !== file.id && isFileChecked(file.id),
              }"
              @click="selectedFileId = file.id"
              @dblclick="downloadSpecificFile(file)"
            >
              <td class="px-3 py-2 align-top">
                <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="isFileChecked(file.id)" @click.stop @change="setFileChecked(file.id, ($event.target as HTMLInputElement).checked)" />
              </td>
              <td class="max-w-[440px] px-4 py-2 align-top">
                <div class="truncate font-medium" :title="displayName(file)">{{ displayName(file) }}</div>
                <div v-if="file.aliases?.length" class="mt-1 truncate text-xs text-muted-foreground" :title="file.aliases.join(', ')">{{ file.aliases.join(", ") }}</div>
              </td>
              <td class="px-4 py-2 align-top whitespace-nowrap text-[12px] text-muted-foreground">{{ file.id }}</td>
              <td class="px-4 py-2 align-top whitespace-nowrap tabular-nums text-muted-foreground">{{ formatBytes(file.length) }}</td>
              <td class="px-4 py-2 align-top whitespace-nowrap tabular-nums text-muted-foreground">{{ formatBytes(file.chunkSize || 0) }}</td>
              <td class="px-4 py-2 align-top whitespace-nowrap tabular-nums text-muted-foreground">{{ formattedUploadDate(file.uploadDate) }}</td>
              <td class="px-4 py-2 align-top whitespace-nowrap text-muted-foreground">{{ file.contentType || "-" }}</td>
              <td class="px-4 py-2 align-top whitespace-nowrap text-[12px] text-muted-foreground">{{ file.md5 || "-" }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside class="overflow-auto border-t border-border px-4 py-4 xl:w-80 xl:shrink-0 xl:border-t-0">
        <template v-if="selectedFile">
          <div class="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{{ t("tabs.gridfs") }}</div>
          <div class="mt-2 break-all text-lg font-semibold">{{ displayName(selectedFile) }}</div>
          <div class="mt-1 break-all text-xs text-muted-foreground">{{ selectedFile.id }}</div>

          <div class="mt-5 space-y-4 text-sm">
            <div>
              <div class="text-xs text-muted-foreground">{{ t("gridfsBrowser.totalSize") }}</div>
              <div class="mt-1 font-medium">{{ formatBytes(selectedFile.length) }}</div>
            </div>
            <div>
              <div class="text-xs text-muted-foreground">{{ t("gridfsBrowser.chunkSize") }}</div>
              <div class="mt-1 font-medium">{{ formatBytes(selectedFile.chunkSize || 0) }}</div>
            </div>
            <div>
              <div class="text-xs text-muted-foreground">{{ t("gridfsBrowser.uploadDate") }}</div>
              <div class="mt-1 font-medium">{{ formattedUploadDate(selectedFile.uploadDate) }}</div>
            </div>
            <div>
              <div class="text-xs text-muted-foreground">{{ t("gridfsBrowser.contentType") }}</div>
              <div class="mt-1 break-all font-medium">{{ selectedFile.contentType || "-" }}</div>
            </div>
            <div v-if="selectedFile.md5">
              <div class="text-xs text-muted-foreground">MD5</div>
              <div class="mt-1 break-all font-medium">{{ selectedFile.md5 }}</div>
            </div>
            <div v-if="selectedMetadata">
              <div class="text-xs text-muted-foreground">{{ t("gridfsBrowser.metadata") }}</div>
              <pre class="mt-1 max-h-44 overflow-auto rounded bg-muted px-3 py-2 text-xs whitespace-pre-wrap">{{ selectedMetadata }}</pre>
            </div>
          </div>
        </template>
        <div v-else class="text-sm text-muted-foreground">
          {{ t("gridfsBrowser.selectFile") }}
        </div>
      </aside>
    </div>

    <DangerConfirmDialog
      v-model:open="showDeleteConfirm"
      :loading="deleting"
      :title="t('gridfsBrowser.deleteFileTitle')"
      :message="t('gridfsBrowser.deleteFileMessage')"
      :details="selectedFile ? displayName(selectedFile) : ''"
      :confirm-label="t('gridfsBrowser.deleteFile')"
      @confirm="deleteSelectedFile"
    />
  </div>
</template>
