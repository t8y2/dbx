<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/backend/api";
import { STARROCKS_ALTER_KINDS, isStarRocksAlterJobActive, parseStarRocksAlterJobs, starRocksAlterStatusSql, type StarRocksAlterJob } from "@/lib/table/starrocksAlterStatus";
const props = defineProps<{ connectionId: string; database: string; tableName: string; schema?: string; catalog?: string; paused: boolean; revision: number; dirty: boolean; submittedSql?: string }>();
const emit = defineEmits<{ busy: [value: boolean]; completed: [] }>();
const { t } = useI18n();
const jobs = ref<StarRocksAlterJob[]>([]);
const error = ref("");
const checking = ref(false);
const expanded = ref(false);
const expandedJob = ref<string>();
const submissionJobIds = ref<string[]>([]);
let submissionExistingIds = new Set<string>();
const checkedAt = ref("");
const knownBusy = ref(false);
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let active = true;
let awaitingUntil = 0;
let submittedBaseline = new Set<string>();
const busy = computed(() => knownBusy.value || jobs.value.some(isStarRocksAlterJobActive));
const unfinished = computed(() => jobs.value.filter(isStarRocksAlterJobActive));
const current = computed(() => unfinished.value[0]);
const jobKey = (job: StarRocksAlterJob) => `${job.kind}:${job.id}`;
const localSqlForJob = (job: StarRocksAlterJob) => (props.submittedSql && submissionJobIds.value.includes(jobKey(job)) ? props.submittedSql : undefined);
const stateLabel = (state: string) => (["PENDING", "WAITING_TXN", "RUNNING", "FINISHED", "CANCELLED"].includes(state) ? t(`starrocksStatus.${state}`) : t("starrocksStatus.unknownState", { state }));
const title = computed(() => (error.value ? t("starrocksStatus.queryFailed") : checking.value && !checkedAt.value ? t("starrocksStatus.checking") : current.value ? stateLabel(current.value.state) : t("starrocksStatus.idle")));
function stop() {
  generation++;
  if (timer) clearTimeout(timer);
  timer = undefined;
  checking.value = false;
}
async function refresh() {
  if (!active || props.paused || checking.value) return;
  if (timer) clearTimeout(timer);
  const request = ++generation;
  const connectionId = props.connectionId,
    database = props.database,
    tableName = props.tableName;
  checking.value = true;
  try {
    const results = await Promise.allSettled(
      STARROCKS_ALTER_KINDS.map(async (kind) => {
        const result = await api.executeQuery(connectionId, database, starRocksAlterStatusSql(kind, tableName), props.schema, undefined, { maxRows: 5, timeoutSecs: 10, catalog: props.catalog });
        if (result.execution_error) throw new Error("SHOW ALTER query failed");
        return parseStarRocksAlterJobs(kind, result);
      }),
    );
    if (request !== generation) return;
    const failures = results.filter((result) => result.status === "rejected");
    const next = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const wasBusy = busy.value;
    if (props.submittedSql && awaitingUntil > 0) {
      submissionJobIds.value = [...new Set([...submissionJobIds.value, ...next.filter((job) => !submissionExistingIds.has(jobKey(job))).map(jobKey)])];
    }
    // Keep previous evidence of an active job on a partial failure.
    if (!failures.length) jobs.value = next;
    else {
      const succeeded = STARROCKS_ALTER_KINDS.filter((_, index) => results[index].status === "fulfilled");
      jobs.value = [...jobs.value.filter((job) => !succeeded.includes(job.kind)), ...next];
    }
    error.value = failures.map((result) => (result.status === "rejected" ? String(result.reason?.message ?? result.reason) : "")).join("\n");
    knownBusy.value = next.some(isStarRocksAlterJobActive) || (!!failures.length && wasBusy);
    checkedAt.value = new Date().toLocaleTimeString();
    emit("busy", busy.value);
    const newTerminalJob = awaitingUntil > 0 && next.some((job) => !isStarRocksAlterJobActive(job) && !submittedBaseline.has(`${job.kind}:${job.id}:${job.state}`));
    if (!failures.length && !busy.value && (wasBusy || newTerminalJob)) {
      awaitingUntil = 0;
      emit("completed");
    }
  } catch (cause) {
    if (request !== generation) return;
    error.value = String(cause);
  } finally {
    if (request === generation) {
      checking.value = false;
      if (active && !props.paused && (busy.value || Date.now() < awaitingUntil)) timer = setTimeout(() => void refresh(), 3000);
    }
  }
}
watch(
  () => [props.connectionId, props.database, props.tableName, props.schema, props.catalog],
  () => {
    stop();
    expandedJob.value = undefined;
    submissionJobIds.value = [];
    jobs.value = [];
    knownBusy.value = false;
    error.value = "";
    checkedAt.value = "";
    awaitingUntil = 0;
    emit("busy", false);
    void refresh();
  },
  { immediate: true },
);
watch(
  () => [props.paused, props.revision],
  ([paused, revision], previous) => {
    stop();
    if (revision !== previous?.[1]) {
      awaitingUntil = Date.now() + 30000;
      submissionExistingIds = new Set(jobs.value.map(jobKey));
      submissionJobIds.value = [];
      submittedBaseline = new Set(jobs.value.map((job) => `${job.kind}:${job.id}:${job.state}`));
    }
    if (!paused) void refresh();
  },
);
onActivated(() => {
  active = true;
  void refresh();
});
onDeactivated(() => {
  active = false;
  stop();
});
onBeforeUnmount(() => {
  active = false;
  stop();
});
</script>
<template>
  <div class="shrink-0 rounded-md border bg-muted/20 text-xs" data-starrocks-alter-status>
    <div class="flex flex-wrap items-center gap-2 px-3 py-2" role="status" aria-live="polite">
      <span class="h-2 w-2 rounded-full" :class="error ? 'bg-destructive' : busy ? 'bg-primary animate-pulse' : 'bg-emerald-500'" />
      <span class="font-medium">{{ t("starrocksStatus.label") }} · {{ title }}</span>
      <span v-if="!error && busy && current?.progress !== undefined">{{ current.progress }}%</span>
      <span class="text-muted-foreground">{{ busy ? t("starrocksStatus.polling") : checkedAt ? t("starrocksStatus.checkedAt", { time: checkedAt }) : "" }}</span>
      <div class="ml-auto flex gap-1">
        <Button variant="ghost" size="sm" :aria-expanded="expanded" @click="expanded = !expanded">{{ t("starrocksStatus.details") }}</Button>
        <Button variant="ghost" size="sm" :disabled="checking || paused" @click="refresh">{{ t("starrocksStatus.refresh") }}</Button>
      </div>
    </div>
    <div v-if="expanded" class="max-h-48 overflow-auto border-t px-3 py-2">
      <p v-if="busy" class="mb-2 text-muted-foreground">{{ t("starrocksStatus.busyHint") }}</p>
      <p v-if="!busy && dirty" class="mb-2 text-muted-foreground">{{ t("starrocksStatus.draftHint") }}</p>
      <p v-if="error" class="mb-2 whitespace-pre-wrap break-words text-destructive">{{ t("starrocksStatus.failureHint") }}<br />{{ error }}</p>
      <p v-if="!unfinished.length && !error" class="text-muted-foreground">{{ t("starrocksStatus.noJobs") }}</p>
      <div v-for="job in unfinished" :key="jobKey(job)" class="mt-1 overflow-hidden rounded-md border">
        <button type="button" class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50" :aria-expanded="expandedJob === jobKey(job)" @click="expandedJob = expandedJob === jobKey(job) ? undefined : jobKey(job)">
          <span aria-hidden="true">{{ expandedJob === jobKey(job) ? "▾" : "▸" }}</span>
          <span>{{ job.kind }} #{{ job.id }}</span>
          <span>{{ stateLabel(job.state) }}{{ job.progress !== undefined ? ` · ${job.progress}%` : "" }}</span>
          <span class="ml-auto text-muted-foreground">{{ job.created }}</span>
        </button>
        <div v-if="expandedJob === jobKey(job)" class="border-t bg-background/50 px-3 py-2" data-starrocks-job-sql>
          <p v-if="job.message" class="mb-2 break-words text-muted-foreground">{{ job.message }}</p>
          <p class="mb-1 text-muted-foreground">{{ job.sql ? t("starrocksStatus.sql") : localSqlForJob(job) ? t("starrocksStatus.localSql") : t("starrocksStatus.sqlUnavailable") }}</p>
          <pre v-if="job.sql || localSqlForJob(job)" class="select-text whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono leading-5">{{ job.sql || localSqlForJob(job) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
