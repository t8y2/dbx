<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { normalizeSqlFileEncoding, type SqlFileLineEnding, type SqlFileSnapshotMeta, type SqlProject } from "@/lib/backend/tauri";

const props = defineProps<{
  project: SqlProject | null;
  path: string | null;
}>();

const open = defineModel<boolean>("open", { default: false });

const { t } = useI18n();
const queryStore = useQueryStore();
const { toast } = useToast();

const loading = ref(false);
const snapshots = ref<SqlFileSnapshotMeta[]>([]);
const selected = ref<SqlFileSnapshotMeta | null>(null);
/** 选中快照的完整 content（按需加载，避免一次拉取全部快照内容）。 */
const selectedContent = ref<string | null>(null);
const contentLoading = ref(false);
const showRestoreConfirm = ref(false);
const restoring = ref(false);

const fileName = computed(() => props.path?.split(/[\\/]/).pop() || props.path || "");

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

watch(
  open,
  async (value) => {
    if (!value || !props.project || !props.path) return;
    loading.value = true;
    snapshots.value = [];
    selected.value = null;
    selectedContent.value = null;
    try {
      snapshots.value = await api.listSqlFileSnapshotsMeta(props.project.id, props.path, 20);
      if (snapshots.value.length > 0) selected.value = snapshots.value[0];
    } catch (e: any) {
      toast(t("sqlFileTree.operationFailed", { message: e?.message || String(e) }), 5000);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

/** 内容加载序号：防止快速切换时旧请求覆盖新选中项的内容。 */
let loadSeq = 0;
watch(
  selected,
  async (meta) => {
    if (!meta || !props.project) {
      selectedContent.value = null;
      return;
    }
    const seq = ++loadSeq;
    contentLoading.value = true;
    try {
      const snapshot = await api.getSqlFileSnapshotContent(props.project.id, meta.id);
      if (seq === loadSeq) {
        selectedContent.value = snapshot?.content ?? null;
      }
    } catch (e: any) {
      if (seq === loadSeq) {
        toast(t("sqlFileTree.operationFailed", { message: e?.message || String(e) }), 5000);
        selectedContent.value = null;
      }
    } finally {
      if (seq === loadSeq) contentLoading.value = false;
    }
  },
  { immediate: true },
);

async function executeRestore() {
  if (!props.project || !props.path || !selected.value || !selectedContent.value || restoring.value) return;
  restoring.value = true;
  try {
    const content = selectedContent.value;
    // 还原前先把磁盘当前内容记入快照，保证还原操作本身也可回退。
    try {
      await api.snapshotSqlFileBeforeSave(props.project.id, props.path);
    } catch {
      // 保底快照失败不阻断还原
    }
    // 快照未记录换行符：沿用磁盘当前文件的换行符；文件已不存在时按 lf 重建。
    let lineEnding: SqlFileLineEnding = "lf";
    try {
      const current = await api.readExternalSqlFileSnapshot(props.path);
      lineEnding = current.lineEnding;
    } catch {
      // 文件不存在：保持默认 lf
    }
    const encoding = normalizeSqlFileEncoding(selected.value.encoding);
    const result = await api.writeExternalSqlFile(props.path, content, { encoding, lineEnding });
    if (result.kind !== "written") {
      toast(t("sqlFileTree.localHistoryRestoreFailed", { message: t("sqlFileTree.localHistoryConflict") }), 5000);
      return;
    }
    queryStore.reloadExternalSqlFileContent(props.path, content, result.version, encoding, lineEnding);
    toast(t("sqlFileTree.localHistoryRestored"), 2000);
    open.value = false;
  } catch (e: any) {
    toast(t("sqlFileTree.localHistoryRestoreFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    restoring.value = false;
    showRestoreConfirm.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[760px]">
      <DialogHeader>
        <DialogTitle>{{ t("sqlFileTree.localHistory") }}</DialogTitle>
        <DialogDescription class="truncate" :title="path || ''">{{ fileName }}</DialogDescription>
      </DialogHeader>

      <div class="flex gap-3">
        <div class="w-48 shrink-0 rounded border">
          <div v-if="loading" class="p-3 text-xs text-muted-foreground">{{ t("sqlFileTree.loading") }}</div>
          <div v-else-if="snapshots.length === 0" class="p-3 text-xs text-muted-foreground">{{ t("sqlFileTree.localHistoryEmpty") }}</div>
          <div v-else class="max-h-[420px] overflow-y-auto">
            <div v-for="snap in snapshots" :key="snap.id" class="cursor-default border-b px-2 py-1.5 last:border-b-0 hover:bg-muted/50" :class="selected?.id === snap.id ? 'bg-accent text-accent-foreground' : ''" @click="selected = snap">
              <div class="flex items-center justify-between gap-2 text-[12px]">
                <span class="truncate">{{ formatTime(snap.savedAt) }}</span>
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ formatBytes(snap.byteLen) }}</span>
              </div>
              <div class="text-[10px] uppercase text-muted-foreground">{{ snap.encoding }}</div>
            </div>
          </div>
        </div>

        <div class="min-w-0 flex-1">
          <textarea v-if="selectedContent !== null" readonly :value="selectedContent" class="h-[420px] w-full resize-none rounded border bg-muted/20 p-2 font-mono text-[12px] outline-none" />
          <div v-else-if="contentLoading || loading" class="flex h-[420px] items-center justify-center rounded border text-xs text-muted-foreground">
            {{ t("sqlFileTree.loading") }}
          </div>
          <div v-else class="flex h-[420px] items-center justify-center rounded border text-xs text-muted-foreground">
            {{ t("sqlFileTree.localHistorySelect") }}
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button size="sm" :disabled="!selected || !selectedContent || restoring" @click="showRestoreConfirm = true">{{ t("sqlFileTree.localHistoryRestore") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Restore confirmation dialog -->
  <Dialog v-model:open="showRestoreConfirm">
    <DialogContent class="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>{{ t("sqlFileTree.localHistoryRestore") }}</DialogTitle>
        <DialogDescription>{{ t("sqlFileTree.localHistoryRestoreConfirm") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" size="sm" :disabled="restoring" @click="showRestoreConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button size="sm" :disabled="restoring" @click="executeRestore">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
