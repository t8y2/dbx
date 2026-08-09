<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { AlertTriangle, ArrowUp, File, FileCode2, Folder, Loader2, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/backend/api";
import { pluginFilesystemParentUri, pluginFilesystemRootUri, sortPluginFilesystemEntries } from "@/lib/plugins/pluginFilesystem";
import type { PluginFilesystemEntry, PluginFilesystemProviderContribution } from "@/types/database";
import { useI18n } from "vue-i18n";

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
const previewContentType = ref("");
const previewTruncated = ref(false);
const previewLoading = ref(false);
const previewError = ref("");
let listGeneration = 0;
let previewGeneration = 0;

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
    entries.value = append ? [...entries.value, ...result.entries] : result.entries;
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
  try {
    const result = await api.readPluginFilesystemFile(props.pluginId, props.provider.id, entry.uri, {
      connectionId: props.connectionId,
      maxBytes: 256 * 1024,
    });
    if (generation !== previewGeneration) return;
    const bytes = Uint8Array.from(atob(result.dataBase64), (character) => character.charCodeAt(0));
    preview.value = new TextDecoder().decode(bytes);
    previewContentType.value = result.contentType || entry.contentType || "application/octet-stream";
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
  previewContentType.value = "";
  previewTruncated.value = false;
  previewLoading.value = false;
  previewError.value = "";
}

function formatSize(size?: number) {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

onMounted(() => void load(props.initialUri || rootUri.value));
watch(
  () => [props.pluginId, props.provider.id, props.connectionId, props.initialUri, rootUri.value] as const,
  () => void load(props.initialUri || rootUri.value),
);
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

    <div v-else class="grid min-h-0 flex-1 grid-cols-[minmax(18rem,42%)_minmax(0,1fr)] divide-x">
      <div class="min-h-0 overflow-auto">
        <div v-if="loading && !entries.length" class="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 size-4 animate-spin" />{{ t("pluginPlatform.loadingFiles") }}</div>
        <div v-else-if="!sortedEntries.length" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("pluginPlatform.emptyDirectory") }}</div>
        <div v-else class="min-w-[28rem] text-sm">
          <button
            v-for="entry in sortedEntries"
            :key="entry.uri"
            type="button"
            class="grid w-full grid-cols-[minmax(0,1fr)_7rem_10rem] items-center gap-3 border-b px-3 py-2 text-left hover:bg-muted/50"
            :class="selected?.uri === entry.uri ? 'bg-muted' : ''"
            @click="selected = entry"
            @dblclick="activateEntry(entry)"
          >
            <span class="flex min-w-0 items-center gap-2">
              <Folder v-if="entry.kind === 'directory'" class="size-4 shrink-0 text-amber-500" />
              <FileCode2 v-else-if="entry.contentType?.startsWith('text/')" class="size-4 shrink-0 text-sky-500" />
              <File v-else class="size-4 shrink-0 text-muted-foreground" />
              <span class="truncate" :title="entry.name">{{ entry.name }}</span>
            </span>
            <span class="text-right text-xs tabular-nums text-muted-foreground">{{ entry.kind === "directory" ? "" : formatSize(entry.size) }}</span>
            <span class="truncate text-xs text-muted-foreground" :title="entry.modifiedAt">{{ entry.modifiedAt || "" }}</span>
          </button>
        </div>
        <div v-if="nextCursor" class="flex justify-center p-3">
          <Button size="sm" variant="outline" :disabled="loadingMore" @click="load(currentUri, true)"> <Loader2 v-if="loadingMore" class="mr-2 size-3.5 animate-spin" />{{ t("pluginPlatform.loadMore") }} </Button>
        </div>
      </div>

      <div class="flex min-h-0 min-w-0 flex-col">
        <div v-if="!selected" class="m-auto max-w-sm px-6 text-center text-sm text-muted-foreground">{{ t("pluginPlatform.fileManagerHint") }}</div>
        <template v-else>
          <div class="shrink-0 border-b px-4 py-3">
            <div class="truncate text-sm font-medium" :title="selected.name">{{ selected.name }}</div>
            <div class="mt-1 truncate font-mono text-[11px] text-muted-foreground" :title="selected.uri">{{ selected.uri }}</div>
          </div>
          <div class="min-h-0 flex-1 overflow-auto p-4">
            <div v-if="previewLoading" class="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 size-4 animate-spin" />{{ t("pluginPlatform.loadingPreview") }}</div>
            <div v-else-if="previewError" class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"><AlertTriangle class="mt-0.5 size-4 shrink-0" />{{ previewError }}</div>
            <template v-else-if="preview">
              <div class="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span>{{ previewContentType }}</span>
                <span v-if="previewTruncated">{{ t("pluginPlatform.previewTruncated") }}</span>
              </div>
              <pre class="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-5">{{ preview }}</pre>
            </template>
            <div v-else class="text-sm text-muted-foreground">{{ t("pluginPlatform.previewSelectedFileHint") }}</div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
