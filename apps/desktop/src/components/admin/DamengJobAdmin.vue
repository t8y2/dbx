<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, CalendarClock, DatabaseZap, Loader2, Play, Plus, Power, RefreshCcw, Square, Trash2, XCircle } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import {
  DAMENG_JOB_ENVIRONMENT_SQL,
  damengClearJobHistoriesSql,
  damengCreateJobSql,
  damengDropJobSql,
  damengEnableJobSql,
  damengInitJobSystemSql,
  damengJobHistoriesSql,
  damengJobListSql,
  damengJobSchedulesSql,
  damengJobStepsSql,
  damengRunJobSql,
  damengStopJobSql,
  isDamengJobEnvironmentMissingError,
  parseDamengJobEnvironmentReady,
  parseDamengJobs,
  queryResultToObjects,
  type DamengJob,
} from "@/lib/database/damengJobAdmin";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

type DetailTab = "steps" | "schedules" | "histories";

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const jobs = ref<DamengJob[]>([]);
const selectedJobName = ref("");
const search = ref("");
const loadingJobs = ref(false);
const loadingDetails = ref(false);
const applying = ref(false);
const jobEnvironmentReady = ref(true);
const loadError = ref("");
const detailError = ref("");
const detailTab = ref<DetailTab>("steps");
const detailRows = ref<Record<string, unknown>[]>([]);

const createDialogOpen = ref(false);
const previewDialogOpen = ref(false);
const pendingSql = ref("");
const pendingAfterApply = ref<(() => Promise<void>) | undefined>();
const pendingDanger = ref(false);
const pendingUseTransaction = ref(false);

const createName = ref("JOB_TEST");
const createEnabled = ref(true);
const createDescription = ref("");
const createStepName = ref("STEP1");
const createCommand = ref("SELECT 1;");
const createScheduleName = ref("SCHEDULE1");
const createScheduleMode = ref<"once" | "daily">("daily");
const createStartDate = ref("CURDATE");
const createStartTime = ref("00:00:00");
const createEndTime = ref("");
const createMinuteInterval = ref(0);

const supported = computed(() => props.connection.db_type === "dameng");
const executionDatabase = computed(() => (props.connection.db_type === "dameng" ? "" : props.connection.database || ""));
const useSystemJobTables = computed(() => props.connection.username?.trim().toUpperCase() === "SYSDBA");
const selectedJob = computed(() => jobs.value.find((job) => job.name === selectedJobName.value));
const filteredJobs = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return jobs.value;
  return jobs.value.filter((job) => `${job.name} ${job.owner || ""} ${job.description || ""}`.toLowerCase().includes(query));
});
const detailColumns = computed(() => {
  const set = new Set<string>();
  for (const row of detailRows.value) {
    Object.keys(row).forEach((key) => set.add(key));
  }
  return Array.from(set);
});
const canCreateJob = computed(() => createName.value.trim() && createStepName.value.trim() && createScheduleName.value.trim() && createCommand.value.trim());

async function ensureConnection() {
  await connectionStore.ensureConnected(props.connection.id);
}

async function loadJobs() {
  if (!supported.value) return;
  loadingJobs.value = true;
  loadError.value = "";
  try {
    await ensureConnection();
    const environment = await api.executeQuery(props.connection.id, executionDatabase.value, DAMENG_JOB_ENVIRONMENT_SQL, undefined, undefined, {
      maxRows: 1,
    });
    jobEnvironmentReady.value = parseDamengJobEnvironmentReady(environment);
    if (!jobEnvironmentReady.value) {
      jobs.value = [];
      detailRows.value = [];
      selectedJobName.value = "";
      return;
    }
    const result = await api.executeQuery(props.connection.id, executionDatabase.value, damengJobListSql(useSystemJobTables.value), undefined, undefined, {
      maxRows: 5000,
    });
    jobs.value = parseDamengJobs(result);
    if (!selectedJob.value) selectedJobName.value = jobs.value[0]?.name || "";
    await loadDetails();
  } catch (error: any) {
    const message = error?.message || String(error);
    if (isDamengJobEnvironmentMissingError(message)) {
      jobEnvironmentReady.value = false;
      loadError.value = "";
    } else {
      loadError.value = message;
    }
    jobs.value = [];
    detailRows.value = [];
  } finally {
    loadingJobs.value = false;
  }
}

async function loadDetails() {
  const job = selectedJob.value;
  if (!job) {
    detailRows.value = [];
    return;
  }
  loadingDetails.value = true;
  detailError.value = "";
  try {
    const sql = detailTab.value === "steps" ? damengJobStepsSql(job.id, useSystemJobTables.value) : detailTab.value === "schedules" ? damengJobSchedulesSql(job.id, useSystemJobTables.value) : damengJobHistoriesSql(job, useSystemJobTables.value);
    const result = await api.executeQuery(props.connection.id, executionDatabase.value, sql, undefined, undefined, {
      maxRows: 1000,
    });
    detailRows.value = queryResultToObjects(result);
  } catch (error: any) {
    detailError.value = error?.message || String(error);
    detailRows.value = [];
  } finally {
    loadingDetails.value = false;
  }
}

function selectJob(job: DamengJob) {
  selectedJobName.value = job.name;
}

function previewSql(sql: string, options: { danger?: boolean; afterApply?: () => Promise<void>; useTransaction?: boolean } = {}) {
  pendingSql.value = sql;
  pendingDanger.value = !!options.danger;
  pendingUseTransaction.value = !!options.useTransaction;
  pendingAfterApply.value = options.afterApply;
  previewDialogOpen.value = true;
}

async function applyPendingSql() {
  if (!pendingSql.value.trim()) return;
  applying.value = true;
  try {
    await ensureConnection();
    const result = await executeWithProductionSqlGuard({
      connection: props.connection,
      database: executionDatabase.value,
      sql: pendingSql.value,
      source: t("production.sourceAdmin"),
      execute: () =>
        api.executeMulti(props.connection.id, executionDatabase.value, pendingSql.value, undefined, undefined, {
          maxRows: 1000,
          useTransaction: pendingUseTransaction.value,
        }),
    });
    if (!result) return;
    toast(t("damengJobAdmin.applySuccess"), 2500);
    previewDialogOpen.value = false;
    await (pendingAfterApply.value?.() ?? Promise.resolve());
    await loadJobs();
  } catch (error: any) {
    toast(t("damengJobAdmin.applyFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    applying.value = false;
  }
}

function previewCreateEnvironment() {
  previewSql(damengInitJobSystemSql());
}

function previewCreateJob() {
  if (!canCreateJob.value) return;
  previewSql(
    damengCreateJobSql({
      name: createName.value,
      enabled: createEnabled.value,
      description: createDescription.value,
      stepName: createStepName.value,
      command: createCommand.value,
      scheduleName: createScheduleName.value,
      scheduleMode: createScheduleMode.value,
      startDate: createStartDate.value,
      startTime: createStartTime.value,
      endTime: createEndTime.value,
      minuteInterval: createMinuteInterval.value,
    }),
    {
      afterApply: async () => {
        createDialogOpen.value = false;
      },
      useTransaction: true,
    },
  );
}

function previewEnableJob(enabled: boolean) {
  const job = selectedJob.value;
  if (!job) return;
  previewSql(damengEnableJobSql(job.name, enabled));
}

function previewDropJob() {
  const job = selectedJob.value;
  if (!job) return;
  previewSql(damengDropJobSql(job.name), { danger: true });
}

function previewRunJob() {
  const job = selectedJob.value;
  if (!job) return;
  const sql = damengRunJobSql(job.id);
  if (sql) previewSql(sql);
}

function previewStopJob() {
  const job = selectedJob.value;
  if (!job) return;
  const sql = damengStopJobSql(job.id);
  if (sql) previewSql(sql, { danger: true });
}

function previewClearHistories() {
  const job = selectedJob.value;
  if (!job) return;
  previewSql(damengClearJobHistoriesSql(job.name), { danger: true });
}

function cellText(value: unknown): string {
  return value == null ? "" : String(value);
}

watch(selectedJobName, () => void loadDetails());
watch(detailTab, () => void loadDetails());
onMounted(() => void loadJobs());
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <CalendarClock class="h-4 w-4 text-primary" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">{{ t("damengJobAdmin.title") }}</div>
        <div class="truncate text-[11px] text-muted-foreground">{{ connection.name }}</div>
      </div>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loadingJobs" @click="loadJobs">
        <Loader2 v-if="loadingJobs" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCcw v-else class="h-3.5 w-3.5" />
        {{ t("contextMenu.refreshChildren") }}
      </Button>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="jobEnvironmentReady" :title="jobEnvironmentReady ? t('damengJobAdmin.environmentReady') : t('damengJobAdmin.initEnvironment')" @click="previewCreateEnvironment">
        <DatabaseZap class="h-3.5 w-3.5" />
        {{ jobEnvironmentReady ? t("damengJobAdmin.environmentReady") : t("damengJobAdmin.initEnvironment") }}
      </Button>
      <Button size="sm" class="h-8 gap-1.5" @click="createDialogOpen = true">
        <Plus class="h-3.5 w-3.5" />
        {{ t("damengJobAdmin.newJob") }}
      </Button>
    </div>

    <div v-if="!supported" class="m-4 rounded border border-dashed p-4 text-sm text-muted-foreground">
      {{ t("damengJobAdmin.unsupported") }}
    </div>

    <div v-else class="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
      <aside class="flex min-h-0 flex-col border-r">
        <div class="border-b p-2">
          <Input v-model="search" class="h-8 text-xs" :placeholder="t('damengJobAdmin.searchJob')" />
        </div>
        <div v-if="loadError" class="m-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <div class="mb-1 flex items-center gap-1 font-medium"><AlertTriangle class="h-3.5 w-3.5" />{{ t("damengJobAdmin.loadFailed") }}</div>
          <div class="break-all">{{ loadError }}</div>
        </div>
        <div v-else-if="!jobEnvironmentReady" class="m-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-300">
          <div class="mb-1 flex items-center gap-1 font-medium"><AlertTriangle class="h-3.5 w-3.5" />{{ t("damengJobAdmin.environmentMissingTitle") }}</div>
          <div>{{ t("damengJobAdmin.environmentMissingHint") }}</div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto p-2">
          <button v-for="job in filteredJobs" :key="job.name" type="button" class="mb-1 w-full rounded border px-2 py-2 text-left text-xs transition hover:bg-accent" :class="selectedJobName === job.name ? 'border-primary bg-primary/10' : 'border-transparent'" @click="selectJob(job)">
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-medium">{{ job.name }}</span>
              <Badge v-if="job.running" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ t("damengJobAdmin.running") }}</Badge>
              <Badge :variant="job.enabled ? 'default' : 'secondary'" class="h-5 px-1.5 text-[10px]">{{ job.enabled ? t("damengJobAdmin.enabled") : t("damengJobAdmin.disabled") }}</Badge>
            </div>
            <div class="mt-1 truncate text-[11px] text-muted-foreground">{{ job.owner || "-" }} · {{ job.valid || "-" }}</div>
          </button>
          <div v-if="!loadingJobs && filteredJobs.length === 0" class="p-6 text-center text-xs text-muted-foreground">
            {{ t("damengJobAdmin.emptyJobs") }}
          </div>
        </div>
      </aside>

      <main class="flex min-h-0 flex-col">
        <div v-if="selectedJob" class="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold">{{ selectedJob.name }}</div>
            <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Badge v-if="selectedJob.running" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ t("damengJobAdmin.running") }}</Badge>
              <span class="truncate">{{ selectedJob.description || t("damengJobAdmin.noDescription") }}</span>
            </div>
          </div>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" @click="previewRunJob">
            <Play class="h-3.5 w-3.5" />
            {{ t("damengJobAdmin.runAsync") }}
          </Button>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="!selectedJob.running" :title="selectedJob.running ? t('damengJobAdmin.stopRunning') : t('damengJobAdmin.stopRunningDisabled')" @click="previewStopJob">
            <Square class="h-3.5 w-3.5" />
            {{ t("damengJobAdmin.stopRunning") }}
          </Button>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" @click="previewEnableJob(!selectedJob.enabled)">
            <Power class="h-3.5 w-3.5" />
            {{ selectedJob.enabled ? t("damengJobAdmin.disable") : t("damengJobAdmin.enable") }}
          </Button>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" @click="previewClearHistories">
            <XCircle class="h-3.5 w-3.5" />
            {{ t("damengJobAdmin.clearHistories") }}
          </Button>
          <Button size="sm" variant="destructive" class="h-8 gap-1.5" @click="previewDropJob">
            <Trash2 class="h-3.5 w-3.5" />
            {{ t("damengJobAdmin.dropJob") }}
          </Button>
        </div>

        <div v-if="selectedJob" class="flex h-10 shrink-0 items-center gap-1 border-b px-3">
          <Button size="sm" :variant="detailTab === 'steps' ? 'secondary' : 'ghost'" class="h-7 px-2 text-xs" @click="detailTab = 'steps'">{{ t("damengJobAdmin.steps") }}</Button>
          <Button size="sm" :variant="detailTab === 'schedules' ? 'secondary' : 'ghost'" class="h-7 px-2 text-xs" @click="detailTab = 'schedules'">{{ t("damengJobAdmin.schedules") }}</Button>
          <Button size="sm" :variant="detailTab === 'histories' ? 'secondary' : 'ghost'" class="h-7 px-2 text-xs" @click="detailTab = 'histories'">{{ t("damengJobAdmin.histories") }}</Button>
          <Loader2 v-if="loadingDetails" class="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>

        <div class="min-h-0 flex-1 overflow-auto p-3">
          <div v-if="!jobEnvironmentReady" class="flex h-full items-center justify-center">
            <div class="max-w-xl rounded-lg border border-dashed p-5 text-sm">
              <div class="mb-2 flex items-center gap-2 font-semibold"><DatabaseZap class="h-4 w-4 text-primary" />{{ t("damengJobAdmin.environmentMissingTitle") }}</div>
              <p class="mb-4 text-xs leading-5 text-muted-foreground">{{ t("damengJobAdmin.environmentMissingDescription") }}</p>
              <Button size="sm" class="gap-1.5" @click="previewCreateEnvironment">
                <DatabaseZap class="h-3.5 w-3.5" />
                {{ t("damengJobAdmin.initEnvironment") }}
              </Button>
            </div>
          </div>
          <div v-else-if="!selectedJob" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            {{ t("damengJobAdmin.selectJob") }}
          </div>
          <div v-else-if="detailError" class="rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {{ detailError }}
          </div>
          <table v-else class="w-full min-w-max border-collapse text-xs">
            <thead>
              <tr class="border-b bg-muted/40">
                <th v-for="column in detailColumns" :key="column" class="px-2 py-2 text-left font-medium">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in detailRows" :key="index" class="border-b hover:bg-muted/30">
                <td v-for="column in detailColumns" :key="column" class="max-w-[360px] px-2 py-2 align-top">
                  <span class="block truncate" :title="cellText(row[column])">{{ cellText(row[column]) || "-" }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="selectedJob && !loadingDetails && !detailError && detailRows.length === 0" class="p-8 text-center text-xs text-muted-foreground">
            {{ t("damengJobAdmin.emptyDetails") }}
          </div>
        </div>
      </main>
    </div>

    <Dialog v-model:open="createDialogOpen">
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ t("damengJobAdmin.newJob") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 text-xs">
          <div class="grid grid-cols-2 gap-3">
            <label class="grid gap-1">
              <span>{{ t("damengJobAdmin.jobName") }}</span>
              <Input v-model="createName" class="h-8 text-xs" />
            </label>
            <label class="grid gap-1">
              <span>{{ t("damengJobAdmin.description") }}</span>
              <Input v-model="createDescription" class="h-8 text-xs" />
            </label>
          </div>
          <label class="flex items-center gap-2">
            <input v-model="createEnabled" type="checkbox" />
            <span>{{ t("damengJobAdmin.enabled") }}</span>
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="grid gap-1">
              <span>{{ t("damengJobAdmin.stepName") }}</span>
              <Input v-model="createStepName" class="h-8 text-xs" />
            </label>
            <label class="grid gap-1">
              <span>{{ t("damengJobAdmin.scheduleName") }}</span>
              <Input v-model="createScheduleName" class="h-8 text-xs" />
            </label>
          </div>
          <label class="grid gap-1">
            <span>{{ t("damengJobAdmin.sqlCommand") }}</span>
            <textarea v-model="createCommand" class="min-h-28 rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <div class="grid grid-cols-5 gap-3">
            <label class="grid gap-1">
              <span>{{ t("damengJobAdmin.scheduleMode") }}</span>
              <select v-model="createScheduleMode" class="h-8 rounded-md border bg-background px-2 text-xs">
                <option value="daily">{{ t("damengJobAdmin.daily") }}</option>
                <option value="once">{{ t("damengJobAdmin.once") }}</option>
              </select>
            </label>
            <label class="grid gap-1">
              <span>{{ t("damengJobAdmin.startDate") }}</span>
              <Input v-model="createStartDate" class="h-8 text-xs" />
            </label>
            <label class="grid gap-1">
              <span>{{ t("damengJobAdmin.startTime") }}</span>
              <Input v-model="createStartTime" class="h-8 text-xs" />
            </label>
            <label class="grid gap-1">
              <span>{{ t("damengJobAdmin.endTime") }}</span>
              <Input v-model="createEndTime" class="h-8 text-xs" placeholder="23:59:59" />
            </label>
            <label class="grid gap-1">
              <span>{{ t("damengJobAdmin.minuteInterval") }}</span>
              <Input v-model.number="createMinuteInterval" type="number" min="0" max="1439" class="h-8 text-xs" />
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!canCreateJob" @click="previewCreateJob">{{ t("damengJobAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="previewDialogOpen">
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ t("damengJobAdmin.sqlPreview") }}</DialogTitle>
        </DialogHeader>
        <pre class="max-h-[50vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs"><code>{{ pendingSql }}</code></pre>
        <DialogFooter>
          <Button variant="outline" @click="previewDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :variant="pendingDanger ? 'destructive' : 'default'" :disabled="applying" @click="applyPendingSql">
            <Loader2 v-if="applying" class="mr-1 h-3.5 w-3.5 animate-spin" />
            {{ t("damengJobAdmin.applySql") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
