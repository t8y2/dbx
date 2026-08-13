<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { normalizeSqlFileEncoding, type SqlFileLineEnding, type SqlFileSnapshot, type SqlProject } from "@/lib/backend/tauri";

const props = defineProps<{
  project: SqlProject | null;
  path: string | null;
}>();

const open = defineModel<boolean>("open", { default: false });

const { t } = useI18n();
const queryStore = useQueryStore();
const { toast } = useToast();

const loading = ref(false);
const snapshots = ref<SqlFileSnapshot[]>([]);
const selected = ref<SqlFileSnapshot | null>(null);
const showRestoreConfirm = ref(false);
const restoring = ref(false);

const fileName = computed(() => props.path?.split(/[\\/]/).pop() || props.path || "");

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

watch(
  open,
  async (value) => {
    if (!value || !props.project || !props.path) return;
    loading.value = true;
    snapshots.value = [];
    selected.value = null;
    try {
      snapshots.value = await api.listSqlFileSnapshots(props.project.id, props.path, 20);
      if (snapshots.value.length > 0) selected.value = snapshots.value[0];
    } catch (e: any) {
      toast(t("sqlFileTree.operationFailed", { message: e?.message || String(e) }), 5000);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

async function executeRestore() {
  if (!props.project || !props.path || !selected.value || restoring.value) return;
  restoring.value = true;
  try {
    const snapshot = selected.value;
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
    const encoding = normalizeSqlFileEncoding(snapshot.encoding);
    const result = await api.writeExternalSqlFile(props.path, snapshot.content, { encoding, lineEnding });
    if (result.kind !== "written") {
      toast(t("sqlFileTree.localHistoryRestoreFailed", { message: t("sqlFileTree.localHistoryConflict") }), 5000);
      return;
    }
    queryStore.reloadExternalSqlFileContent(props.path, snapshot.content, result.version, encoding, lineEnding);
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
              <div class="text-[12px]">{{ formatTime(snap.savedAt) }}</div>
              <div class="text-[10px] uppercase text-muted-foreground">{{ snap.encoding }}</div>
            </div>
          </div>
        </div>

        <div class="min-w-0 flex-1">
          <textarea v-if="selected" readonly :value="selected.content" class="h-[420px] w-full resize-none rounded border bg-muted/20 p-2 font-mono text-[12px] outline-none" />
          <div v-else class="flex h-[420px] items-center justify-center rounded border text-xs text-muted-foreground">
            {{ t("sqlFileTree.localHistorySelect") }}
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button size="sm" :disabled="!selected || restoring" @click="showRestoreConfirm = true">{{ t("sqlFileTree.localHistoryRestore") }}</Button>
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
