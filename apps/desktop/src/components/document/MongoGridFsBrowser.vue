<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen, Plus, RefreshCcw, Trash2 } from "@lucide/vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const props = defineProps<{
  connectionId: string;
  database: string;
}>();

const { t } = useI18n();
const { toast } = useToast();
const queryStore = useQueryStore();
const connectionStore = useConnectionStore();

const loading = ref(false);
const creating = ref(false);
const deleting = ref(false);
const error = ref("");
const buckets = ref<Awaited<ReturnType<typeof api.documentListGridFsBuckets>>>([]);
const selectedBucketName = ref("");
const showCreateDialog = ref(false);
const showDeleteConfirm = ref(false);
const newBucketName = ref("");

const selectedBucket = computed(() => buckets.value.find((bucket) => bucket.name === selectedBucketName.value) || null);
const totalFiles = computed(() => buckets.value.reduce((sum, bucket) => sum + bucket.fileCount, 0));
const totalBytes = computed(() => buckets.value.reduce((sum, bucket) => sum + bucket.totalBytes, 0));
const isReadonly = computed(() => connectionStore.getConfig(props.connectionId)?.read_only ?? false);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function loadBuckets() {
  loading.value = true;
  error.value = "";
  try {
    const nextBuckets = await api.documentListGridFsBuckets(props.connectionId, props.database);
    buckets.value = nextBuckets;
    if (selectedBucketName.value && !nextBuckets.some((bucket) => bucket.name === selectedBucketName.value)) {
      selectedBucketName.value = "";
    }
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function openBucket(bucketName = selectedBucketName.value) {
  if (!bucketName) return;
  queryStore.openMongoBucket(props.connectionId, props.database, bucketName);
}

async function createBucket() {
  const bucketName = newBucketName.value.trim();
  if (!bucketName || creating.value) return;
  creating.value = true;
  try {
    await api.documentCreateGridFsBucket(props.connectionId, props.database, bucketName);
    showCreateDialog.value = false;
    newBucketName.value = "";
    selectedBucketName.value = bucketName;
    await loadBuckets();
    toast(t("gridfsBrowser.bucketCreated", { bucket: bucketName }), 2500);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    creating.value = false;
  }
}

async function deleteBucket() {
  const bucketName = selectedBucketName.value;
  if (!bucketName || deleting.value) return;
  deleting.value = true;
  try {
    await api.documentDeleteGridFsBucket(props.connectionId, props.database, bucketName);
    showDeleteConfirm.value = false;
    selectedBucketName.value = "";
    await loadBuckets();
    toast(t("gridfsBrowser.bucketDeleted", { bucket: bucketName }), 2500);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    deleting.value = false;
  }
}

onMounted(() => {
  void loadBuckets();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="border-b border-border px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold">{{ database }} / {{ t("tabs.gridfs") }}</div>
          <div class="text-xs text-muted-foreground">{{ buckets.length }} {{ t("gridfsBrowser.bucketCount") }} / {{ totalFiles }} {{ t("gridfsBrowser.fileCount") }} / {{ formatBytes(totalBytes) }}</div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" class="h-8 gap-1.5" :disabled="isReadonly" @click="showCreateDialog = true">
            <Plus class="h-3.5 w-3.5" />
            {{ t("gridfsBrowser.createBucket") }}
          </Button>
          <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="!selectedBucket" @click="openBucket()">
            <FolderOpen class="h-3.5 w-3.5" />
            {{ t("gridfsBrowser.openBucket") }}
          </Button>
          <Button variant="destructive" size="sm" class="h-8 gap-1.5" :disabled="isReadonly || !selectedBucket || deleting" @click="showDeleteConfirm = true">
            <Trash2 class="h-3.5 w-3.5" />
            {{ t("gridfsBrowser.deleteBucket") }}
          </Button>
          <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="loading" @click="loadBuckets">
            <RefreshCcw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
            {{ t("grid.refresh") }}
          </Button>
        </div>
      </div>
    </div>

    <div v-if="error" class="px-4 py-3 text-sm text-destructive">
      {{ error }}
    </div>

    <div v-else-if="loading && buckets.length === 0" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {{ t("executionSummary.executing") }}
    </div>

    <div v-else-if="buckets.length === 0" class="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
      {{ t("gridfsBrowser.emptyBuckets") }}
    </div>

    <div v-else class="min-h-0 flex-1 flex-col xl:flex-row xl:divide-x xl:divide-border">
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="min-w-full border-collapse text-sm">
          <thead class="sticky top-0 z-10 bg-background">
            <tr class="border-b border-border text-left text-xs text-muted-foreground">
              <th class="px-4 py-2 font-medium">{{ t("gridfsBrowser.name") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("gridfsBrowser.fileCount") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("gridfsBrowser.totalSize") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="bucket in buckets" :key="bucket.name" class="cursor-pointer border-b border-border/60 transition-colors hover:bg-muted/40" :class="{ 'bg-accent/45': selectedBucketName === bucket.name }" @click="selectedBucketName = bucket.name" @dblclick="openBucket(bucket.name)">
              <td class="px-4 py-2 font-medium">{{ bucket.name }}</td>
              <td class="px-4 py-2 text-muted-foreground">{{ bucket.fileCount }}</td>
              <td class="px-4 py-2 text-muted-foreground">{{ formatBytes(bucket.totalBytes) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside class="border-t border-border px-4 py-4 xl:w-72 xl:shrink-0 xl:border-t-0">
        <template v-if="selectedBucket">
          <div class="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{{ t("tabs.gridfs") }}</div>
          <div class="mt-2 break-all text-lg font-semibold">{{ selectedBucket.name }}</div>

          <div class="mt-5 space-y-4 text-sm">
            <div>
              <div class="text-xs text-muted-foreground">{{ t("gridfsBrowser.fileCount") }}</div>
              <div class="mt-1 font-medium">{{ selectedBucket.fileCount }}</div>
            </div>
            <div>
              <div class="text-xs text-muted-foreground">{{ t("gridfsBrowser.totalSize") }}</div>
              <div class="mt-1 font-medium">{{ formatBytes(selectedBucket.totalBytes) }}</div>
            </div>
          </div>
        </template>
        <div v-else class="text-sm text-muted-foreground">
          {{ t("gridfsBrowser.selectBucket") }}
        </div>
      </aside>
    </div>

    <Dialog v-model:open="showCreateDialog">
      <DialogContent class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t("gridfsBrowser.createTitle") }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-2 py-2">
          <label class="text-sm font-medium">{{ t("gridfsBrowser.bucketName") }}</label>
          <Input v-model="newBucketName" :placeholder="t('gridfsBrowser.bucketNamePlaceholder')" @keydown.enter="createBucket" />
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="creating" @click="showCreateDialog = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="creating || !newBucketName.trim()" class="gap-1.5" @click="createBucket">
            <RefreshCcw v-if="creating" class="h-3.5 w-3.5 animate-spin" />
            {{ t("gridfsBrowser.createBucket") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <DangerConfirmDialog v-model:open="showDeleteConfirm" :loading="deleting" :title="t('gridfsBrowser.deleteTitle')" :message="t('gridfsBrowser.deleteMessage')" :details="selectedBucketName" :confirm-label="t('gridfsBrowser.deleteBucket')" @confirm="deleteBucket" />
  </div>
</template>
