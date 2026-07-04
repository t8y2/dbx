<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Download, RefreshCcw, Trash2, Upload } from "@lucide/vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import { useToast } from "@/composables/useToast";
import { downloadBinaryCellPayload, type BinaryCellDownloadPayload } from "@/lib/binaryCellDownload";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import * as api from "@/lib/api";
import { useConnectionStore } from "@/stores/connectionStore";

const props = defineProps<{
  connectionId: string;
  database: string;
  bucket: string;
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const loading = ref(false);
const uploading = ref(false);
const deleting = ref(false);
const error = ref("");
const files = ref<Awaited<ReturnType<typeof api.documentListGridFsFiles>>>([]);
const selectedFileId = ref("");
const showDeleteConfirm = ref(false);

const totalBytes = computed(() => files.value.reduce((sum, file) => sum + (file.length || 0), 0));
const selectedFile = computed(() => files.value.find((file) => file.id === selectedFileId.value) || null);
const selectedMetadata = computed(() => (selectedFile.value?.metadata ? JSON.stringify(selectedFile.value.metadata, null, 2) : ""));
const isReadonly = computed(() => connectionStore.getConfig(props.connectionId)?.read_only ?? false);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function displayName(file: (typeof files.value)[number]): string {
  return file.filename || file.id;
}

async function loadFiles() {
  loading.value = true;
  error.value = "";
  try {
    const nextFiles = await api.documentListGridFsFiles(props.connectionId, props.database, props.bucket);
    files.value = nextFiles;
    if (selectedFileId.value && !nextFiles.some((file) => file.id === selectedFileId.value)) {
      selectedFileId.value = "";
    }
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function downloadFile(file: (typeof files.value)[number]) {
  try {
    const bytes = await api.documentDownloadGridFsFile(props.connectionId, props.database, props.bucket, file.id);
    const payload: BinaryCellDownloadPayload = {
      data: bytes,
      mimeType: file.contentType || "application/octet-stream",
      extension: file.filename?.includes(".") ? file.filename.split(".").pop() || "bin" : "bin",
    };
    const result = await downloadBinaryCellPayload(payload, displayName(file));
    if (result.kind === "saved") {
      toast(t("grid.exported"), 2500);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
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
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="border-b border-border px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold">{{ database }}.{{ bucket }}</div>
          <div class="text-xs text-muted-foreground">{{ files.length }} {{ t("gridfsBrowser.fileCount") }} / {{ formatBytes(totalBytes) }}</div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" class="h-8 gap-1.5" :disabled="isReadonly || uploading" @click="uploadFile">
            <Upload class="h-3.5 w-3.5" />
            {{ t("gridfsBrowser.uploadFile") }}
          </Button>
          <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="!selectedFile" @click="selectedFile && downloadFile(selectedFile)">
            <Download class="h-3.5 w-3.5" />
            {{ t("gridfsBrowser.downloadFile") }}
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

    <div v-else class="min-h-0 flex-1 flex-col xl:flex-row xl:divide-x xl:divide-border">
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="min-w-full border-collapse text-sm">
          <thead class="sticky top-0 z-10 bg-background">
            <tr class="border-b border-border text-left text-xs text-muted-foreground">
              <th class="px-4 py-2 font-medium">{{ t("gridfsBrowser.name") }}</th>
              <th class="px-4 py-2 font-medium">ID</th>
              <th class="px-4 py-2 font-medium">{{ t("gridfsBrowser.totalSize") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("gridfsBrowser.chunkSize") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("gridfsBrowser.uploadDate") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("gridfsBrowser.contentType") }}</th>
              <th class="px-4 py-2 font-medium">MD5</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="file in files" :key="file.id" class="cursor-pointer border-b border-border/60 transition-colors hover:bg-muted/40" :class="{ 'bg-accent/45': selectedFileId === file.id }" @click="selectedFileId = file.id" @dblclick="downloadFile(file)">
              <td class="px-4 py-2 align-top">
                <div class="font-medium">{{ displayName(file) }}</div>
                <div v-if="file.aliases?.length" class="mt-1 text-xs text-muted-foreground">{{ file.aliases.join(", ") }}</div>
              </td>
              <td class="px-4 py-2 align-top text-xs text-muted-foreground">{{ file.id }}</td>
              <td class="px-4 py-2 align-top text-muted-foreground">{{ formatBytes(file.length) }}</td>
              <td class="px-4 py-2 align-top text-muted-foreground">{{ formatBytes(file.chunkSize || 0) }}</td>
              <td class="px-4 py-2 align-top text-muted-foreground">{{ file.uploadDate || "-" }}</td>
              <td class="px-4 py-2 align-top text-muted-foreground">{{ file.contentType || "-" }}</td>
              <td class="px-4 py-2 align-top text-xs text-muted-foreground">{{ file.md5 || "-" }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside class="border-t border-border px-4 py-4 xl:w-80 xl:shrink-0 xl:border-t-0">
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
              <div class="mt-1 font-medium">{{ selectedFile.uploadDate || "-" }}</div>
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
