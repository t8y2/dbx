<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, Download, File, Folder, FolderPlus, Loader2, Pencil, Plus, RefreshCw, Trash2, Upload } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import type { S3Bucket, S3ObjectPreview, S3ObjectSummary } from "@/types/s3";

const props = defineProps<{
  connectionId: string;
  initialBucket?: string;
  readOnly?: boolean;
}>();

const { t } = useI18n();
const { toast } = useToast();

const loading = ref(false);
const error = ref("");
const buckets = ref<S3Bucket[]>([]);
const bucket = ref(props.initialBucket || "");
const prefix = ref("");
const objects = ref<S3ObjectSummary[]>([]);
const folderPrefixes = ref<string[]>([]);
const nextContinuationToken = ref<string | null>(null);
const hasMoreObjects = ref(false);
const loadingMore = ref(false);
const selectedKey = ref("");
const preview = ref<S3ObjectPreview | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);
const showCreateBucketDialog = ref(false);
const showDeleteBucketDialog = ref(false);
const showCreateFolderDialog = ref(false);
const showObjectActionDialog = ref(false);
const creatingBucket = ref(false);
const deletingBucket = ref(false);
const creatingFolder = ref(false);
const objectActionLoading = ref(false);
const newBucketName = ref("");
const newFolderName = ref("");
const objectActionMode = ref<"copy" | "move" | "rename">("copy");
const targetBucket = ref("");
const targetKey = ref("");

const selectedBucketInfo = computed(() => buckets.value.find((item) => item.name === bucket.value) || null);
const selectedObjectName = computed(() => {
  const parts = selectedKey.value.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : selectedKey.value;
});

const breadcrumbSegments = computed(() => {
  const trimmed = prefix.value.replace(/^\/+/, "");
  if (!trimmed) return [] as string[];
  return trimmed.split("/").filter(Boolean);
});

async function loadBuckets() {
  loading.value = true;
  error.value = "";
  try {
    buckets.value = await api.s3ListBuckets(props.connectionId);
    if (!bucket.value && buckets.value.length === 1) {
      bucket.value = buckets.value[0].name;
    }
  } catch (caught) {
    error.value = translateBackendError(t, caught);
  } finally {
    loading.value = false;
  }
}

async function createBucket() {
  const nextBucket = newBucketName.value.trim();
  if (!nextBucket || props.readOnly || creatingBucket.value) return;
  creatingBucket.value = true;
  error.value = "";
  try {
    await api.s3CreateBucket(props.connectionId, nextBucket);
    showCreateBucketDialog.value = false;
    newBucketName.value = "";
    await loadBuckets();
    bucket.value = nextBucket;
    toast(t("s3.bucketCreated", { bucket: nextBucket }), 2500);
  } catch (caught) {
    const message = translateBackendError(t, caught);
    error.value = message;
    toast(message, 5000);
  } finally {
    creatingBucket.value = false;
  }
}

async function deleteBucket() {
  if (!bucket.value || props.readOnly || deletingBucket.value) return;
  deletingBucket.value = true;
  error.value = "";
  try {
    const bucketName = bucket.value;
    await api.s3DeleteBucket(props.connectionId, bucketName);
    showDeleteBucketDialog.value = false;
    preview.value = null;
    selectedKey.value = "";
    bucket.value = "";
    prefix.value = "";
    objects.value = [];
    folderPrefixes.value = [];
    await loadBuckets();
    toast(t("s3.bucketDeleted", { bucket: bucketName }), 2500);
  } catch (caught) {
    const message = translateBackendError(t, caught);
    error.value = message;
    toast(message, 5000);
  } finally {
    deletingBucket.value = false;
  }
}

async function loadObjects() {
  await loadObjectsPage(true);
}

async function loadObjectsPage(reset: boolean) {
  if (!bucket.value) return;
  if (reset) {
    loading.value = true;
    nextContinuationToken.value = null;
    hasMoreObjects.value = false;
  } else {
    loadingMore.value = true;
  }
  error.value = "";
  try {
    if (reset) {
      preview.value = null;
      selectedKey.value = "";
    }
    const response = await api.s3ListObjects(props.connectionId, bucket.value, prefix.value, "/", 200, reset ? null : nextContinuationToken.value);
    const nextPrefixes = response.prefixes.map((entry) => entry.prefix);
    const nextObjects = response.objects.filter((entry) => entry.key !== prefix.value);
    if (reset) {
      folderPrefixes.value = nextPrefixes;
      objects.value = nextObjects;
    } else {
      folderPrefixes.value = Array.from(new Set([...folderPrefixes.value, ...nextPrefixes]));
      const seen = new Set(objects.value.map((entry) => entry.key));
      objects.value = [...objects.value, ...nextObjects.filter((entry) => !seen.has(entry.key))];
    }
    hasMoreObjects.value = response.isTruncated;
    nextContinuationToken.value = response.nextContinuationToken || null;
  } catch (caught) {
    error.value = translateBackendError(t, caught);
  } finally {
    if (reset) {
      loading.value = false;
    } else {
      loadingMore.value = false;
    }
  }
}

async function loadMoreObjects() {
  if (!hasMoreObjects.value || !nextContinuationToken.value || loading.value || loadingMore.value) return;
  await loadObjectsPage(false);
}

async function openPrefix(nextPrefix: string) {
  prefix.value = nextPrefix;
  await loadObjects();
}

async function openObject(key: string) {
  selectedKey.value = key;
  loading.value = true;
  error.value = "";
  try {
    preview.value = await api.s3PreviewObject(props.connectionId, bucket.value, key, 256 * 1024);
  } catch (caught) {
    error.value = translateBackendError(t, caught);
  } finally {
    loading.value = false;
  }
}

async function deleteSelected() {
  if (!selectedKey.value || props.readOnly) return;
  loading.value = true;
  error.value = "";
  try {
    await api.s3DeleteObject(props.connectionId, bucket.value, selectedKey.value);
    preview.value = null;
    selectedKey.value = "";
    await loadObjects();
    toast(t("s3.objectDeleted"), 2500);
  } catch (caught) {
    const message = translateBackendError(t, caught);
    error.value = message;
    toast(message, 5000);
  } finally {
    loading.value = false;
  }
}

function base64FromBytes(bytes: Uint8Array) {
  let result = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(result);
}

function triggerUpload() {
  uploadInput.value?.click();
}

async function onUploadSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !bucket.value || props.readOnly) return;
  const key = `${prefix.value}${file.name}`.replace(/^\/+/, "");
  loading.value = true;
  error.value = "";
  try {
    const buffer = await file.arrayBuffer();
    const payloadBase64 = base64FromBytes(new Uint8Array(buffer));
    await api.s3UploadObject(props.connectionId, bucket.value, key, payloadBase64, file.type || undefined);
    await loadObjects();
    toast(t("s3.objectUploaded", { key: file.name }), 2500);
  } catch (caught) {
    const message = translateBackendError(t, caught);
    error.value = message;
    toast(message, 5000);
  } finally {
    loading.value = false;
  }
}

async function downloadSelected() {
  if (!bucket.value || !selectedKey.value || loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const bytes = new Uint8Array(await api.s3DownloadObject(props.connectionId, bucket.value, selectedKey.value));
    const type = preview.value?.contentType || "application/octet-stream";
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = selectedObjectName.value || "download";
    link.click();
    URL.revokeObjectURL(url);
  } catch (caught) {
    const message = translateBackendError(t, caught);
    error.value = message;
    toast(message, 5000);
  } finally {
    loading.value = false;
  }
}

function openCreateFolderDialog() {
  newFolderName.value = "";
  showCreateFolderDialog.value = true;
}

async function createFolder() {
  const folderName = newFolderName.value.trim().replace(/^\/+|\/+$/g, "");
  if (!bucket.value || !folderName || props.readOnly || creatingFolder.value) return;
  creatingFolder.value = true;
  error.value = "";
  try {
    const key = `${prefix.value}${folderName}/`.replace(/^\/+/, "");
    await api.s3UploadObject(props.connectionId, bucket.value, key, "", "application/x-directory");
    showCreateFolderDialog.value = false;
    newFolderName.value = "";
    await loadObjects();
    toast(t("s3.folderCreated", { name: folderName }), 2500);
  } catch (caught) {
    const message = translateBackendError(t, caught);
    error.value = message;
    toast(message, 5000);
  } finally {
    creatingFolder.value = false;
  }
}

function openObjectActionDialog(mode: "copy" | "move" | "rename") {
  if (!bucket.value || !selectedKey.value) return;
  objectActionMode.value = mode;
  targetBucket.value = bucket.value;
  if (mode === "rename") {
    targetKey.value = `${prefix.value}${selectedObjectName.value}`.replace(/^\/+/, "");
  } else {
    targetKey.value = selectedKey.value;
  }
  showObjectActionDialog.value = true;
}

async function submitObjectAction() {
  if (!bucket.value || !selectedKey.value || !targetBucket.value.trim() || !targetKey.value.trim() || props.readOnly || objectActionLoading.value) return;
  objectActionLoading.value = true;
  error.value = "";
  const nextBucket = targetBucket.value.trim();
  const nextKey = targetKey.value.trim().replace(/^\/+/, "");
  try {
    if (objectActionMode.value === "copy") {
      await api.s3CopyObject(props.connectionId, bucket.value, selectedKey.value, nextBucket, nextKey);
      toast(t("s3.objectCopied"), 2500);
    } else {
      await api.s3MoveObject(props.connectionId, bucket.value, selectedKey.value, nextBucket, nextKey);
      toast(t(objectActionMode.value === "rename" ? "s3.objectRenamed" : "s3.objectMoved"), 2500);
    }
    showObjectActionDialog.value = false;
    if (nextBucket === bucket.value) {
      await loadObjects();
      if (objectActionMode.value !== "copy") {
        selectedKey.value = nextKey;
        await openObject(nextKey);
      }
    }
  } catch (caught) {
    const message = translateBackendError(t, caught);
    error.value = message;
    toast(message, 5000);
  } finally {
    objectActionLoading.value = false;
  }
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

watch(
  () => props.connectionId,
  () => {
    void loadBuckets();
  },
  { immediate: true },
);

watch(bucket, () => {
  prefix.value = "";
  if (bucket.value) void loadObjects();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" class="h-9 gap-1.5" :disabled="loading || readOnly" @click="showCreateBucketDialog = true">
        <Plus class="h-3.5 w-3.5" />
        {{ t("s3.createBucket") }}
      </Button>
      <Button size="sm" variant="outline" class="h-9 gap-1.5" :disabled="loading || !bucket || readOnly" @click="showDeleteBucketDialog = true">
        <Trash2 class="h-3.5 w-3.5" />
        {{ t("s3.deleteBucket") }}
      </Button>
      <select v-model="bucket" class="h-9 min-w-48 rounded-md border bg-background px-2 text-sm">
        <option value="">{{ t("s3.selectBucket") }}</option>
        <option v-for="item in buckets" :key="item.name" :value="item.name">{{ item.name }}</option>
      </select>
      <Input v-model="prefix" class="h-9 min-w-64 flex-1 font-mono text-xs" :placeholder="t('s3.prefixPlaceholder')" @keydown.enter="loadObjects" />
      <Button size="sm" variant="outline" class="h-9 gap-1.5" :disabled="loading || loadingMore || !bucket" @click="loadObjects">
        <RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
        {{ t("s3.refresh") }}
      </Button>
      <Button size="sm" variant="outline" class="h-9 gap-1.5" :disabled="loading || !bucket || readOnly" @click="triggerUpload">
        <Upload class="h-3.5 w-3.5" />
        {{ t("s3.upload") }}
      </Button>
      <Button size="sm" variant="outline" class="h-9 gap-1.5" :disabled="loading || !bucket || readOnly" @click="openCreateFolderDialog">
        <FolderPlus class="h-3.5 w-3.5" />
        {{ t("s3.createFolder") }}
      </Button>
      <Button size="sm" variant="outline" class="h-9 gap-1.5" :disabled="loading || !selectedKey" @click="downloadSelected">
        <Download class="h-3.5 w-3.5" />
        {{ t("s3.download") }}
      </Button>
      <Button size="sm" variant="outline" class="h-9 gap-1.5" :disabled="loading || !selectedKey || readOnly" @click="openObjectActionDialog('copy')">
        <Copy class="h-3.5 w-3.5" />
        {{ t("s3.copy") }}
      </Button>
      <Button size="sm" variant="outline" class="h-9 gap-1.5" :disabled="loading || !selectedKey || readOnly" @click="openObjectActionDialog('move')">
        <File class="h-3.5 w-3.5" />
        {{ t("s3.move") }}
      </Button>
      <Button size="sm" variant="outline" class="h-9 gap-1.5" :disabled="loading || !selectedKey || readOnly" @click="openObjectActionDialog('rename')">
        <Pencil class="h-3.5 w-3.5" />
        {{ t("s3.rename") }}
      </Button>
      <Button size="sm" variant="destructive" class="h-9 gap-1.5" :disabled="loading || !selectedKey || readOnly" @click="deleteSelected">
        <Trash2 class="h-3.5 w-3.5" />
        {{ t("s3.delete") }}
      </Button>
      <input ref="uploadInput" type="file" class="hidden" @change="onUploadSelected" />
    </div>

    <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{{ buckets.length }} {{ t("s3.buckets") }}</span>
      <span v-if="selectedBucketInfo?.creationDate">• {{ selectedBucketInfo.creationDate }}</span>
    </div>

    <div v-if="bucket" class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <button class="hover:text-foreground" @click="openPrefix('')">{{ bucket }}</button>
      <template v-for="(segment, index) in breadcrumbSegments" :key="`${segment}-${index}`">
        <span>/</span>
        <button class="hover:text-foreground" @click="openPrefix(`${breadcrumbSegments.slice(0, index + 1).join('/')}/`)">
          {{ segment }}
        </button>
      </template>
    </div>

    <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ error }}</div>

    <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div class="min-h-0 overflow-auto rounded-md border">
        <div v-if="loading && !objects.length && !folderPrefixes.length" class="flex h-32 items-center justify-center text-sm text-muted-foreground">
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {{ t("s3.loading") }}
        </div>
        <button v-for="folder in folderPrefixes" :key="folder" class="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-muted/40" @click="openPrefix(folder)">
          <Folder class="h-4 w-4 text-amber-500" />
          <span class="truncate">{{ folder.replace(prefix, "") || folder }}</span>
        </button>
        <button v-for="object in objects" :key="object.key" class="flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm hover:bg-muted/40" :class="selectedKey === object.key ? 'bg-muted/60' : ''" @click="openObject(object.key)">
          <span class="flex min-w-0 items-center gap-2">
            <File class="h-4 w-4 shrink-0 text-sky-500" />
            <span class="truncate font-mono text-xs">{{ object.key.replace(prefix, "") || object.key }}</span>
          </span>
          <Badge variant="outline">{{ formatSize(object.size) }}</Badge>
        </button>
        <div v-if="hasMoreObjects" class="border-t px-3 py-3">
          <Button size="sm" variant="outline" class="w-full gap-1.5" :disabled="loading || loadingMore" @click="loadMoreObjects">
            <Loader2 v-if="loadingMore" class="h-3.5 w-3.5 animate-spin" />
            {{ t("s3.loadMore") }}
          </Button>
        </div>
      </div>

      <div class="min-h-0 overflow-auto rounded-md border p-3">
        <div v-if="!selectedKey" class="flex h-full min-h-32 items-center justify-center text-sm text-muted-foreground">{{ t("s3.selectObject") }}</div>
        <template v-else>
          <div class="mb-2 space-y-1">
            <div class="font-mono text-xs break-all">{{ selectedKey }}</div>
            <div v-if="preview" class="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{{ formatSize(preview.size) }}</Badge>
              <Badge v-if="preview.contentType" variant="outline">{{ preview.contentType }}</Badge>
              <Badge v-if="preview.truncated" variant="outline">{{ t("s3.previewTruncated") }}</Badge>
            </div>
          </div>
          <pre v-if="preview?.previewEncoding === 'text'" class="max-h-[480px] overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-3 text-xs">{{ preview.previewText }}</pre>
          <div v-else-if="preview?.previewBase64" class="text-xs text-muted-foreground">{{ t("s3.binaryPreview") }}</div>
        </template>
      </div>
    </div>

    <Dialog v-model:open="showCreateBucketDialog">
      <DialogContent class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t("s3.createTitle") }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-2 py-2">
          <label class="text-sm font-medium">{{ t("s3.bucketName") }}</label>
          <Input v-model="newBucketName" :placeholder="t('s3.bucketNamePlaceholder')" @keydown.enter="createBucket" />
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="creatingBucket" @click="showCreateBucketDialog = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="creatingBucket || !newBucketName.trim()" class="gap-1.5" @click="createBucket">
            <Loader2 v-if="creatingBucket" class="h-3.5 w-3.5 animate-spin" />
            {{ t("s3.createBucket") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showDeleteBucketDialog">
      <DialogContent class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t("s3.deleteBucketTitle") }}</DialogTitle>
        </DialogHeader>
        <div class="py-2 text-sm text-muted-foreground">{{ t("s3.deleteBucketConfirm", { bucket }) }}</div>
        <DialogFooter>
          <Button variant="outline" :disabled="deletingBucket" @click="showDeleteBucketDialog = false">{{ t("common.cancel") }}</Button>
          <Button variant="destructive" :disabled="deletingBucket || !bucket" class="gap-1.5" @click="deleteBucket">
            <Loader2 v-if="deletingBucket" class="h-3.5 w-3.5 animate-spin" />
            {{ t("s3.deleteBucket") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showCreateFolderDialog">
      <DialogContent class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t("s3.createFolderTitle") }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-2 py-2">
          <label class="text-sm font-medium">{{ t("s3.folderName") }}</label>
          <Input v-model="newFolderName" :placeholder="t('s3.folderNamePlaceholder')" @keydown.enter="createFolder" />
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="creatingFolder" @click="showCreateFolderDialog = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="creatingFolder || !newFolderName.trim()" class="gap-1.5" @click="createFolder">
            <Loader2 v-if="creatingFolder" class="h-3.5 w-3.5 animate-spin" />
            {{ t("s3.createFolder") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showObjectActionDialog">
      <DialogContent class="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{{ t(`s3.${objectActionMode}`) }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-3 py-2">
          <div class="space-y-1">
            <label class="text-sm font-medium">{{ t("s3.targetBucket") }}</label>
            <select v-model="targetBucket" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option v-for="item in buckets" :key="item.name" :value="item.name">{{ item.name }}</option>
            </select>
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium">{{ t("s3.targetKey") }}</label>
            <Input v-model="targetKey" class="font-mono text-xs" :placeholder="t('s3.targetKeyPlaceholder')" @keydown.enter="submitObjectAction" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="objectActionLoading" @click="showObjectActionDialog = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="objectActionLoading || !targetBucket.trim() || !targetKey.trim()" class="gap-1.5" @click="submitObjectAction">
            <Loader2 v-if="objectActionLoading" class="h-3.5 w-3.5 animate-spin" />
            {{ t(`s3.${objectActionMode}`) }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
