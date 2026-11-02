<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, ArrowRightLeft, CheckCircle2, ChevronDown, ChevronRight, Loader2, Minimize2, X, XCircle } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDataTransferDuration, useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { translateBackendError } from "@/i18n/backend-errors";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import {
  editOracleRoutineDraft,
  editOraclePackageOptions,
  executeOracleRoutineDeployment,
  includeOraclePackageCompanion,
  observeOracleRoutineDeployment,
  prepareOracleRoutineRecovery,
  refreshOracleRoutineDeployment,
  reviewOraclePackageTargetDraft,
  selectOracleRoutineDraft,
  validateOracleRoutineDeployment,
} from "@/lib/schema/oracleRoutineDeploy";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { useConnectionStore } from "@/stores/connectionStore";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ task: ExportTask }>();
const connectionStore = useConnectionStore();
const packageDeployment = computed(() => props.task.oracleRoutineDeployment);
const showPackageReview = ref(true);
const packageDraftSql = computed(() => packageDeployment.value?.drafts.find((draft) => draft.objectId === packageDeployment.value?.selectedObjectId)?.sql ?? "");
const packageConfirmOpen = ref(false);
const packageConfirmSql = ref("");
let resolvePackageConfirmation: ((confirmed: boolean) => void) | undefined;
const { cancelTask } = useExportTracker();
const currentTime = ref(Date.now());
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

const isActive = computed(() => ["Running", "Writing", "Cancelling"].includes(props.task.status));

// 「执行日志」区（#13281）：逐表记录传输进度，默认展开、可折叠；新日志到达时自动滚到底部。
const showTaskLog = ref(true);
const taskLogEl = ref<HTMLElement>();
watch(
  () => props.task.logLines?.length ?? 0,
  () => {
    void nextTick(() => {
      const el = taskLogEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

// 与 admin 面板的 formatClock 同款：日志时间戳只关心当天时分秒。
function formatLogTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const progressPercent = computed(() => {
  if (props.task.status === "Done") return 100;
  if (!props.task.totalTables) return 0;
  return Math.min(95, Math.round(((props.task.tableIndex ?? 0) / props.task.totalTables) * 100));
});
const elapsed = computed(() => {
  const startedAt = props.task.startedAt ?? currentTime.value;
  return formatDataTransferDuration((props.task.finishedAt ?? currentTime.value) - startedAt);
});
const statusText = computed(() => {
  if (props.task.status === "Cancelling") return t("databaseBackup.cancelling");
  if (props.task.status === "Done") return t("exportProgress.compareDone");
  if (props.task.status === "Error") return t("exportProgress.compareError");
  if (props.task.status === "Cancelled") return t("exportProgress.compareCancelled");
  return t("exportProgress.compareRunning");
});

function settlePackageConfirmation(confirmed: boolean) {
  const resolve = resolvePackageConfirmation;
  resolvePackageConfirmation = undefined;
  packageConfirmOpen.value = false;
  resolve?.(confirmed);
}

async function executePackageRepair() {
  const state = packageDeployment.value;
  if (!state || isActive.value) return;
  await executeOracleRoutineDeployment(state, async (sql, run) => {
    packageConfirmSql.value = sql;
    const confirmed = await new Promise<boolean>((resolve) => {
      resolvePackageConfirmation = resolve;
      packageConfirmOpen.value = true;
    });
    if (!confirmed) return;
    await executeWithProductionSqlGuard({ connection: connectionStore.getConfig(state.target.endpoint.connectionId), database: state.target.endpoint.database, sql, source: t("transfer.title"), execute: run });
  });
}

async function refreshPackageResults() {
  const state = packageDeployment.value;
  if (state) await refreshOracleRoutineDeployment(state, { source: state.source.endpoint, target: state.target.endpoint });
}

watch(packageConfirmOpen, (isOpen) => {
  if (!isOpen) settlePackageConfirmation(false);
});
watch(open, (isOpen) => {
  if (!isOpen) {
    settlePackageConfirmation(false);
    if (packageDeployment.value) packageDeployment.value.stopRequested = true;
  }
});

onMounted(() => {
  elapsedTimer = setInterval(() => {
    currentTime.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
  settlePackageConfirmation(false);
  if (packageDeployment.value) packageDeployment.value.stopRequested = true;
});
</script>

<template>
  <Dialog :open="open" @update:open="open = $event">
    <DialogContent :class="packageDeployment && showPackageReview ? 'flex h-[85vh] min-h-0 flex-col sm:max-w-[1120px]' : 'sm:max-w-lg'" data-transfer-progress-dialog @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <ArrowRightLeft class="h-4 w-4" />
          {{ t("exportProgress.dataTransferTitle", { name: task.tableName }) }}
        </DialogTitle>
      </DialogHeader>

      <div class="space-y-4 py-3">
        <div class="flex items-center gap-2 text-sm">
          <Loader2 v-if="isActive" class="h-4 w-4 animate-spin text-primary" />
          <CheckCircle2 v-else-if="task.status === 'Done'" class="h-4 w-4 text-green-500" />
          <XCircle v-else-if="task.status === 'Error'" class="h-4 w-4 text-destructive" />
          <AlertCircle v-else class="h-4 w-4 text-yellow-500" />
          <span>{{ statusText }}</span>
        </div>

        <div class="space-y-1.5">
          <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div v-if="task.totalTables" class="h-full rounded-full transition-[width] duration-300" :class="task.status === 'Done' ? 'bg-green-500' : 'bg-primary'" :style="{ width: `${progressPercent}%` }" />
            <div v-else-if="isActive" class="export-progress-indeterminate h-full rounded-full bg-primary" />
          </div>
          <div class="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span class="truncate">{{ task.currentTable || task.tableName }}</span>
            <span v-if="!packageDeployment || task.totalTables" class="shrink-0 tabular-nums">{{ task.tableIndex ?? 0 }} / {{ task.totalTables ?? 0 }} · {{ task.rowsExported.toLocaleString() }} {{ t("exportProgress.rowsShort") }}</span>
          </div>
          <div class="text-xs text-muted-foreground">{{ t("exportProgress.elapsed", { duration: elapsed }) }}</div>
        </div>

        <div v-if="task.errorMessage" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {{ translateBackendError(t, task.errorMessage) }}
        </div>

        <div v-if="task.logLines?.length" class="space-y-1.5">
          <button type="button" class="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground" @click="showTaskLog = !showTaskLog">
            <ChevronDown v-if="showTaskLog" class="h-3.5 w-3.5" />
            <ChevronRight v-else class="h-3.5 w-3.5" />
            {{ t("transfer.log.title") }}
            <span class="ml-auto tabular-nums">{{ task.logLines.length }}</span>
          </button>
          <div v-show="showTaskLog" ref="taskLogEl" class="max-h-44 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs leading-relaxed">
            <div v-for="(line, index) in task.logLines" :key="index" class="flex gap-2" :class="line.level === 'error' ? 'text-destructive' : line.level === 'success' ? 'text-green-600 dark:text-green-400' : 'text-foreground'">
              <span class="shrink-0 tabular-nums text-muted-foreground">{{ formatLogTime(line.at) }}</span>
              <span class="min-w-0 break-words">{{ t(line.key, line.params ?? {}) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="packageDeployment && showPackageReview" class="min-h-0 flex-1 overflow-hidden rounded border">
        <SchemaDiffDeployStep
          :deploy-sql="packageDraftSql"
          :selected-objects="[]"
          :target-connection-id="packageDeployment.target.endpoint.connectionId"
          :target-database="packageDeployment.target.endpoint.database"
          :target-schema="packageDeployment.target.endpoint.schema"
          :database-type="packageDeployment.target.endpoint.databaseType"
          :routine-deployment="packageDeployment"
          :executing="isActive || packageDeployment.executing"
          :can-execute="!isActive && (packageDeployment.recoveryPlan ?? packageDeployment.plan)?.ready === true"
          @back="showPackageReview = false"
          @select-routine="selectOracleRoutineDraft(packageDeployment, $event)"
          @update:deploy-sql="editOracleRoutineDraft(packageDeployment, packageDeployment.selectedObjectId!, $event)"
          @validate-routines="validateOracleRoutineDeployment(packageDeployment)"
          @refresh-routines="refreshPackageResults"
          @observe-routine="observeOracleRoutineDeployment(packageDeployment, $event)"
          @recover-routine="prepareOracleRoutineRecovery(packageDeployment, $event)"
          @include-package-companion="(id, source) => includeOraclePackageCompanion(packageDeployment!, id, source)"
          @update-package-options="(id, options) => editOraclePackageOptions(packageDeployment!, id, options)"
          @review-package-target="reviewOraclePackageTargetDraft(packageDeployment, $event)"
          @deploy="executePackageRepair"
        />
      </div>

      <DialogFooter>
        <Button v-if="packageDeployment && !showPackageReview" variant="outline" size="sm" @click="showPackageReview = true">{{ t("diff.deployReview") }}</Button>
        <template v-if="isActive">
          <Button variant="ghost" size="sm" @click="open = false">
            <Minimize2 class="mr-1 h-3.5 w-3.5" />
            {{ t("exportProgress.minimize") }}
          </Button>
          <Button variant="outline" size="sm" :disabled="task.status === 'Cancelling'" @click="cancelTask(task.exportId)">
            <Loader2 v-if="task.status === 'Cancelling'" class="mr-1 h-3.5 w-3.5 animate-spin" />
            <X v-else class="mr-1 h-3.5 w-3.5" />
            {{ task.status === "Cancelling" ? t("databaseBackup.cancelling") : t("exportProgress.cancel") }}
          </Button>
        </template>
        <Button v-else variant="outline" size="sm" @click="open = false">{{ t("exportProgress.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  <DangerConfirmDialog v-if="packageDeployment" v-model:open="packageConfirmOpen" :sql="packageConfirmSql" :close-on-confirm="false" @confirm="settlePackageConfirmation(true)" />
</template>

<style scoped>
.export-progress-indeterminate {
  width: 42%;
  animation: export-progress-slide 1.15s ease-in-out infinite;
}

@keyframes export-progress-slide {
  0% {
    transform: translateX(-110%);
  }
  50% {
    transform: translateX(70%);
  }
  100% {
    transform: translateX(250%);
  }
}
</style>
