<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { AlertTriangle, ArrowUp, File, FileCode2, Folder, Loader2, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/backend/api";
import { beginPanelResize, endPanelResize } from "@/lib/app/panelResizeState";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { pluginFilesystemParentUri, pluginFilesystemRootUri, sortPluginFilesystemEntries, uniquePluginFilesystemEntries } from "@/lib/plugins/pluginFilesystem";
import type { PluginFilesystemEntry, PluginFilesystemProviderContribution } from "@/types/database";
import { useI18n } from "vue-i18n";

const FILE_LIST_SIZE_STORAGE_KEY = "dbx-plugin-file-manager-split-size";
const FILE_LIST_DEFAULT_SIZE = 42;
const FILE_LIST_MIN_SIZE = 20;
const FILE_LIST_MAX_SIZE = 80;
const FILE_LIST_KEYBOARD_STEP = 2;

function clampFileListSize(size: number) {
  return Math.min(FILE_LIST_MAX_SIZE, Math.max(FILE_LIST_MIN_SIZE, size));
}

function restoredFileListSize() {
  const saved = Number(safeLocalStorageGet(FILE_LIST_SIZE_STORAGE_KEY));
  return Number.isFinite(saved) && saved >= FILE_LIST_MIN_SIZE && saved <= FILE_LIST_MAX_SIZE ? saved : FILE_LIST_DEFAULT_SIZE;
}

const props = defineProps<{
  pluginId: string;
  provider: PluginFilesystemProviderContribution;
  connectionId?: string;
  initialUri?: string;
}>();

const { t } = useI18n();

const currentUri = ref("");
const address = ref("");
const entries = ref<PluginFilesystemEntry[]>([]);
const nextCursor = ref<string>();
const loading = ref(false);
const loadingMore = ref(false);
const error = ref("");
const selected = ref<PluginFilesystemEntry>();
const preview = ref("");
const previewImageUrl = ref("");
const previewKind = ref<"text" | "image" | "binary">("text");
const previewContentType = ref("");
const previewTruncated = ref(false);
const previewLoading = ref(false);
const previewError = ref("");
const paneGroup = ref<HTMLElement>();
const fileListSize = ref(restoredFileListSize());
const resizingPanes = ref(false);
const paneGridStyle = computed(() => ({ gridTemplateColumns: `minmax(0, ${fileListSize.value}fr) 0.375rem minmax(0, ${100 - fileListSize.value}fr)` }));
let listGeneration = 0;
let previewGeneration = 0;
let resizeHandle: HTMLElement | null = null;
let resizePointerId: number | null = null;
let resizeStartX = 0;
let resizeStartSize = FILE_LIST_DEFAULT_SIZE;
let resizeAvailableWidth = 0;

const rootUri = computed(() => pluginFilesystemRootUri(props.provider));
const canRead = computed(() => (props.provider.capabilities || []).includes("read"));
const sortedEntries = computed(() => sortPluginFilesystemEntries(entries.value));
const parentUri = computed(() => pluginFilesystemParentUri(currentUri.value, rootUri.value));

async function load(uri = address.value || currentUri.value || rootUri.value, append = false) {
  const targetUri = uri.trim() || rootUri.value;
  const generation = ++listGeneration;
  if (append) loadingMore.value = true;
  else loading.value = true;
  error.value = "";
  try {
    const result = await api.listPluginFilesystemEntries(props.pluginId, props.provider.id, {
      connectionId: props.connectionId,
      uri: targetUri,
      cursor: append ? nextCursor.value : undefined,
      limit: 200,
    });
    if (generation !== listGeneration) return;
    currentUri.value = targetUri;
    address.value = targetUri;
    entries.value = append ? uniquePluginFilesystemEntries([...entries.value, ...result.entries]) : uniquePluginFilesystemEntries(result.entries);
    nextCursor.value = result.nextCursor;
    if (!append) clearPreview();
  } catch (cause) {
    if (generation !== listGeneration) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (generation === listGeneration) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

async function activateEntry(entry: PluginFilesystemEntry) {
  selected.value = entry;
  if (entry.kind === "directory") {
    await load(entry.uri);
    return;
  }
  if (!canRead.value || entry.kind !== "file") {
    preview.value = "";
    previewContentType.value = "";
    previewTruncated.value = false;
    previewError.value = canRead.value ? t("pluginPlatform.entryCannotPreview") : t("pluginPlatform.providerNoReadCapability");
    return;
  }
  const generation = ++previewGeneration;
  previewLoading.value = true;
  previewError.value = "";
  revokePreviewImage();
  preview.value = "";
  previewKind.value = "text";
  try {
    const contentType = (entry.contentType || "").split(";", 1)[0].toLowerCase();
    const isImage = contentType.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(entry.name);
    const result = await api.readPluginFilesystemFile(props.pluginId, props.provider.id, entry.uri, {
      connectionId: props.connectionId,
      maxBytes: 256 * 1024,
    });
    if (generation !== previewGeneration) return;
    const bytes = Uint8Array.from(atob(result.dataBase64), (character) => character.charCodeAt(0));
    const resolvedContentType = (result.contentType || entry.contentType || "application/octet-stream").split(";", 1)[0].toLowerCase();
    previewContentType.value = resolvedContentType;
    if (isImage || resolvedContentType.startsWith("image/")) {
      if (result.truncated) {
        previewError.value = t("pluginPlatform.entryCannotPreview");
      } else {
        previewImageUrl.value = URL.createObjectURL(new Blob([bytes], { type: resolvedContentType }));
        previewKind.value = "image";
      }
    } else if (isTextPreview(entry.name, resolvedContentType)) {
      preview.value = new TextDecoder().decode(bytes);
      previewKind.value = "text";
    } else {
      previewKind.value = "binary";
    }
    previewTruncated.value = result.truncated;
  } catch (cause) {
    if (generation !== previewGeneration) return;
    previewError.value = cause instanceof Error ? cause.message : String(cause);
    preview.value = "";
  } finally {
    if (generation === previewGeneration) previewLoading.value = false;
  }
}

function clearPreview() {
  previewGeneration += 1;
  selected.value = undefined;
  preview.value = "";
  revokePreviewImage();
  previewKind.value = "text";
  previewContentType.value = "";
  previewTruncated.value = false;
  previewLoading.value = false;
  previewError.value = "";
}

function revokePreviewImage() {
  if (previewImageUrl.value) URL.revokeObjectURL(previewImageUrl.value);
  previewImageUrl.value = "";
}

function isTextPreview(name: string, contentType: string) {
  return contentType.startsWith("text/") || /^(application\/(json|javascript|xml|yaml)|image\/svg\+xml)$/.test(contentType) || /\.(cjs|css|csv|html?|js|json|md|mjs|toml|ts|tsx|txt|vue|xml|yaml|yml)$/i.test(name);
}

function formatSize(size?: number) {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function setFileListSize(size: number) {
  fileListSize.value = Math.round(clampFileListSize(size) * 10) / 10;
}

function persistFileListSize() {
  safeLocalStorageSet(FILE_LIST_SIZE_STORAGE_KEY, String(fileListSize.value));
}

function cleanupPaneResize() {
  window.removeEventListener("pointermove", resizeFilePanes, true);
  window.removeEventListener("pointerup", finishPaneResize, true);
  window.removeEventListener("pointercancel", cancelPaneResize);
  window.removeEventListener("blur", cancelPaneResize);
  window.removeEventListener("keydown", cancelPaneResizeWithEscape, true);
  resizeHandle?.removeEventListener("lostpointercapture", cancelPaneResize);
  if (resizePointerId !== null && resizeHandle?.hasPointerCapture?.(resizePointerId)) resizeHandle.releasePointerCapture(resizePointerId);
  resizeHandle = null;
  resizePointerId = null;
  if (resizingPanes.value) endPanelResize();
  resizingPanes.value = false;
}

function cancelPaneResize() {
  if (!resizingPanes.value) return;
  setFileListSize(resizeStartSize);
  cleanupPaneResize();
}

function cancelPaneResizeWithEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  cancelPaneResize();
}

function resizeFilePanes(event: PointerEvent) {
  if (event.pointerId !== resizePointerId) return;
  event.preventDefault();
  setFileListSize(resizeStartSize + ((event.clientX - resizeStartX) / resizeAvailableWidth) * 100);
}

function finishPaneResize(event: PointerEvent) {
  if (event.pointerId !== resizePointerId) return;
  resizeFilePanes(event);
  const changed = fileListSize.value !== resizeStartSize;
  cleanupPaneResize();
  if (changed) persistFileListSize();
}

function startPaneResize(event: PointerEvent) {
  if (event.button !== 0 || resizingPanes.value) return;
  const groupWidth = paneGroup.value?.getBoundingClientRect().width ?? 0;
  const handleWidth = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
  resizeAvailableWidth = groupWidth - handleWidth;
  if (resizeAvailableWidth <= 0) return;
  event.preventDefault();
  resizeStartX = event.clientX;
  resizeStartSize = fileListSize.value;
  resizeHandle = event.currentTarget as HTMLElement;
  resizePointerId = event.pointerId;
  resizeHandle.setPointerCapture?.(resizePointerId);
  resizeHandle.addEventListener("lostpointercapture", cancelPaneResize);
  resizingPanes.value = true;
  beginPanelResize();
  window.addEventListener("pointermove", resizeFilePanes, { capture: true, passive: false });
  window.addEventListener("pointerup", finishPaneResize, true);
  window.addEventListener("pointercancel", cancelPaneResize);
  window.addEventListener("blur", cancelPaneResize);
  window.addEventListener("keydown", cancelPaneResizeWithEscape, true);
}

function resizeFilePanesWithKeyboard(event: KeyboardEvent) {
  let nextSize: number;
  if (event.key === "ArrowLeft") nextSize = fileListSize.value - (event.shiftKey ? FILE_LIST_KEYBOARD_STEP * 5 : FILE_LIST_KEYBOARD_STEP);
  else if (event.key === "ArrowRight") nextSize = fileListSize.value + (event.shiftKey ? FILE_LIST_KEYBOARD_STEP * 5 : FILE_LIST_KEYBOARD_STEP);
  else if (event.key === "Home") nextSize = FILE_LIST_MIN_SIZE;
  else if (event.key === "End") nextSize = FILE_LIST_MAX_SIZE;
  else return;
  event.preventDefault();
  setFileListSize(nextSize);
  persistFileListSize();
}

function resetFilePaneSize() {
  cancelPaneResize();
  fileListSize.value = FILE_LIST_DEFAULT_SIZE;
  safeLocalStorageRemove(FILE_LIST_SIZE_STORAGE_KEY);
}

onMounted(() => void load(props.initialUri || rootUri.value));
onBeforeUnmount(() => {
  cancelPaneResize();
  revokePreviewImage();
});
watch(
  () => [props.pluginId, props.provider.id, props.connectionId, props.initialUri, rootUri.value] as const,
  () => void load(props.initialUri || rootUri.value),
);

defineExpose({ refresh: () => load(currentUri.value) });
</script>

<template>
  <div class="flex size-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <Button size="icon" variant="ghost" class="size-8" :disabled="!parentUri || loading" :title="t('pluginPlatform.parentDirectory')" @click="parentUri && load(parentUri)">
        <ArrowUp class="size-4" />
      </Button>
      <Input v-model="address" class="h-8 min-w-0 flex-1 font-mono text-xs" :aria-label="t('pluginPlatform.filesystemUri')" @keydown.enter="load(address)" />
      <Button size="icon" variant="ghost" class="size-8" :disabled="loading" :title="t('pluginPlatform.refresh')" @click="load(currentUri)">
        <Loader2 v-if="loading" class="size-4 animate-spin" />
        <RefreshCw v-else class="size-4" />
      </Button>
    </div>

    <div v-if="error" class="m-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <span>{{ error }}</span>
    </div>

    <div v-else ref="paneGroup" data-file-manager-panes class="grid min-h-0 min-w-0 flex-1 overflow-hidden" :style="paneGridStyle">
      <div data-file-list-pane class="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div v-if="loading && !entries.length" class="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 size-4 animate-spin" />{{ t("pluginPlatform.loadingFiles") }}</div>
        <div v-else-if="!sortedEntries.length" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("pluginPlatform.emptyDirectory") }}</div>
        <RecycleScroller v-else data-file-list class="plugin-file-list min-h-0 min-w-0 flex-1 overflow-x-hidden text-sm" :items="sortedEntries" :item-size="46" :buffer="300" key-field="uri">
          <template #default="{ item: entry }">
            <button type="button" class="plugin-file-row grid h-[46px] w-full min-w-0 items-center gap-3 border-b px-3 text-left hover:bg-muted/50" :class="selected?.uri === entry.uri ? 'bg-muted' : ''" :data-file-entry-uri="entry.uri" @click="selected = entry" @dblclick="activateEntry(entry)">
              <span class="flex min-w-0 items-center gap-2">
                <Folder v-if="entry.kind === 'directory'" class="size-4 shrink-0 text-amber-500" />
                <FileCode2 v-else-if="entry.contentType?.startsWith('text/')" class="size-4 shrink-0 text-sky-500" />
                <File v-else class="size-4 shrink-0 text-muted-foreground" />
                <span class="truncate" :title="entry.name">{{ entry.name }}</span>
              </span>
              <span class="plugin-file-size min-w-0 truncate text-right text-xs tabular-nums text-muted-foreground">{{ entry.kind === "directory" ? "" : formatSize(entry.size) }}</span>
              <span class="plugin-file-modified min-w-0 truncate text-xs text-muted-foreground" :title="entry.modifiedAt">{{ entry.modifiedAt || "" }}</span>
            </button>
          </template>
        </RecycleScroller>
        <div v-if="nextCursor" class="flex shrink-0 justify-center p-3">
          <Button size="sm" variant="outline" :disabled="loadingMore" @click="load(currentUri, true)"> <Loader2 v-if="loadingMore" class="mr-2 size-3.5 animate-spin" />{{ t("pluginPlatform.loadMore") }} </Button>
        </div>
      </div>

      <div
        data-file-preview-resize
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="t('pluginPlatform.filePreviewResize')"
        :aria-valuemin="FILE_LIST_MIN_SIZE"
        :aria-valuemax="FILE_LIST_MAX_SIZE"
        :aria-valuenow="Math.round(fileListSize)"
        :title="t('pluginPlatform.filePreviewResize')"
        class="group relative z-10 h-full w-1.5 cursor-col-resize touch-none border-x border-border/70 bg-background transition-colors hover:bg-primary/25 focus-visible:bg-primary/25 focus-visible:outline-none"
        @pointerdown="startPaneResize"
        @dblclick="resetFilePaneSize"
        @keydown="resizeFilePanesWithKeyboard"
      >
        <span class="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>

      <div data-file-preview-pane class="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div v-if="!selected" class="m-auto max-w-sm px-6 text-center text-sm text-muted-foreground">{{ t("pluginPlatform.fileManagerHint") }}</div>
        <template v-else>
          <div class="shrink-0 border-b px-4 py-3">
            <div class="truncate text-sm font-medium" :title="selected.name">{{ selected.name }}</div>
            <div class="mt-1 truncate font-mono text-[11px] text-muted-foreground" :title="selected.uri">{{ selected.uri }}</div>
          </div>
          <div class="min-h-0 flex-1 overflow-auto p-4">
            <div v-if="previewLoading" class="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 size-4 animate-spin" />{{ t("pluginPlatform.loadingPreview") }}</div>
            <div v-else-if="previewError" class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"><AlertTriangle class="mt-0.5 size-4 shrink-0" />{{ previewError }}</div>
            <template v-else-if="previewKind === 'image' && previewImageUrl">
              <img :src="previewImageUrl" :alt="selected.name" class="max-h-full max-w-full rounded-md object-contain" />
            </template>
            <template v-else-if="previewKind === 'text' && preview">
              <div class="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span>{{ previewContentType }}</span>
                <span v-if="previewTruncated">{{ t("pluginPlatform.previewTruncated") }}</span>
              </div>
              <pre class="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-5">{{ preview }}</pre>
            </template>
            <div v-else-if="previewKind === 'binary'" class="m-auto max-w-sm text-center text-sm text-muted-foreground">{{ t("pluginPlatform.entryCannotPreview") }}</div>
            <div v-else class="text-sm text-muted-foreground">{{ t("pluginPlatform.previewSelectedFileHint") }}</div>
          </div>
        </template>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="resizingPanes" class="plugin-file-resize-overlay fixed inset-0 cursor-col-resize touch-none select-none" aria-hidden="true" />
    </Teleport>
  </div>
</template>

<style scoped>
.plugin-file-list {
  container: plugin-file-list / inline-size;
}

.plugin-file-row {
  grid-template-columns: minmax(0, 1fr) 7rem 10rem;
}

@container plugin-file-list (max-width: 28rem) {
  .plugin-file-row {
    grid-template-columns: minmax(0, 1fr) 6rem;
  }

  .plugin-file-modified {
    display: none;
  }
}

@container plugin-file-list (max-width: 20rem) {
  .plugin-file-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .plugin-file-size {
    display: none;
  }
}

.plugin-file-resize-overlay {
  z-index: 2147483646;
}
</style>
