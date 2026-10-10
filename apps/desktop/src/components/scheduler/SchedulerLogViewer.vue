<script setup lang="ts">
// Run log viewer (ADR §7.3): snapshot once, then subscribe to scheduler events
// and append only new seqs. An incremental `afterSeq` tail fetch is the
// fallback while the run is active — a full reload per tick is forbidden.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { subscribeSchedulerEvents } from "@/lib/scheduler/schedulerEvents";
import { getRunLogs } from "@/lib/scheduler/schedulerApi";
import type { TaskLogEntry, TaskRunStatus } from "@/lib/scheduler/schedulerTypes";

const props = defineProps<{
  runId: string;
  /** Finished runs stop tailing; active runs keep the incremental tail alive. */
  runStatus?: TaskRunStatus;
}>();

const { t, locale } = useI18n();

const entries = ref<TaskLogEntry[]>([]);
const nextSeq = ref(0);
const eof = ref(true);
const loading = ref(false);
const error = ref("");
const streamFilter = ref<"all" | TaskLogEntry["stream"]>("all");
const levelFilter = ref<"all" | TaskLogEntry["level"]>("all");

const TAIL_INTERVAL_MS = 5000;
const SNAPSHOT_LIMIT = 500;

let unlisten: (() => void) | undefined;
let tailTimer: ReturnType<typeof setInterval> | undefined;
let disposed = false;

const visibleEntries = computed(() => entries.value.filter((entry) => (streamFilter.value === "all" || entry.stream === streamFilter.value) && (levelFilter.value === "all" || entry.level === levelFilter.value)));

const isActiveRun = computed(() => props.runStatus === "queued" || props.runStatus === "starting" || props.runStatus === "running");

function appendEntries(incoming: readonly TaskLogEntry[]) {
  if (incoming.length === 0) return;
  // nextSeq is "last seen + 1" (ADR §7.3), so anything at or above it is new;
  // the server never rewrites old seqs, so duplicates are filtered out.
  const fresh = incoming.filter((entry) => entry.seq >= nextSeq.value);
  if (fresh.length === 0) return;
  entries.value = [...entries.value, ...fresh].slice(-5000);
  nextSeq.value = Math.max(...fresh.map((entry) => entry.seq)) + 1;
}

async function loadSnapshot() {
  loading.value = true;
  error.value = "";
  try {
    const page = await getRunLogs(props.runId, { afterSeq: 0, limit: SNAPSHOT_LIMIT });
    if (disposed || props.runId !== requestId) return;
    entries.value = page.entries;
    nextSeq.value = page.nextSeq;
    eof.value = page.eof;
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (!disposed) loading.value = false;
  }
}

/** Incremental fallback: fetch only entries after the last seen seq. */
async function tail() {
  if (disposed || eof.value) return;
  try {
    const page = await getRunLogs(props.runId, { afterSeq: nextSeq.value, limit: SNAPSHOT_LIMIT });
    if (disposed || props.runId !== requestId) return;
    appendEntries(page.entries);
    eof.value = page.eof;
  } catch {
    // The next tick retries; events remain the primary update path.
  }
}

// Snapshot identity: switching runs mid-flight must not apply stale pages.
let requestId = "";

function stopTailing() {
  if (tailTimer) {
    clearInterval(tailTimer);
    tailTimer = undefined;
  }
}

watch(
  () => [props.runId, props.runStatus] as const,
  async ([runId]) => {
    if (runId === requestId) return;
    requestId = runId;
    entries.value = [];
    nextSeq.value = 0;
    eof.value = true;
    await loadSnapshot();
  },
  { immediate: true },
);

watch(
  isActiveRun,
  (active) => {
    if (active && !tailTimer) tailTimer = setInterval(() => void tail(), TAIL_INTERVAL_MS);
    if (!active) stopTailing();
  },
  { immediate: true },
);

onMounted(async () => {
  unlisten = await subscribeSchedulerEvents((event) => {
    if (event.type === "run-log" && event.runId === props.runId && event.entries) {
      appendEntries(event.entries);
      eof.value = false;
    }
  });
});

onUnmounted(() => {
  disposed = true;
  stopTailing();
  unlisten?.();
  unlisten = undefined;
});

function formatTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return value;
  return new Intl.DateTimeFormat(locale.value, { timeStyle: "medium" }).format(new Date(value));
}

function entryClass(entry: TaskLogEntry): string {
  if (entry.level === "error") return "text-destructive";
  if (entry.level === "warn") return "text-amber-600 dark:text-amber-400";
  if (entry.stream === "system") return "text-muted-foreground";
  return "";
}
</script>

<template>
  <div class="flex flex-col gap-2" data-scheduler-log-viewer>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <Select v-model="streamFilter">
          <SelectTrigger class="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{{ t("scheduler.log.stream.all") }}</SelectItem>
            <SelectItem value="stdout">{{ t("scheduler.log.stream.stdout") }}</SelectItem>
            <SelectItem value="stderr">{{ t("scheduler.log.stream.stderr") }}</SelectItem>
            <SelectItem value="system">{{ t("scheduler.log.stream.system") }}</SelectItem>
          </SelectContent>
        </Select>
        <Select v-model="levelFilter">
          <SelectTrigger class="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{{ t("scheduler.log.level.all") }}</SelectItem>
            <SelectItem value="debug">{{ t("scheduler.log.level.debug") }}</SelectItem>
            <SelectItem value="info">{{ t("scheduler.log.level.info") }}</SelectItem>
            <SelectItem value="warn">{{ t("scheduler.log.level.warn") }}</SelectItem>
            <SelectItem value="error">{{ t("scheduler.log.level.error") }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button v-if="!eof" variant="outline" size="sm" class="h-7 text-xs" :disabled="loading" data-scheduler-log-tail @click="() => void tail()">
        {{ t("scheduler.log.tail") }}
      </Button>
    </div>

    <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
    <div class="max-h-72 min-h-24 overflow-y-auto rounded-md border border-border/70 bg-muted/30 p-2 font-mono text-xs leading-5" data-scheduler-log-entries>
      <p v-if="visibleEntries.length === 0" class="px-1 py-2 text-muted-foreground">{{ loading ? "…" : t("scheduler.log.empty") }}</p>
      <div v-for="entry in visibleEntries" :key="entry.seq" class="flex gap-2 whitespace-pre-wrap break-all" :data-scheduler-log-seq="entry.seq">
        <span class="shrink-0 tabular-nums text-muted-foreground">{{ entry.seq }}</span>
        <span class="shrink-0 tabular-nums text-muted-foreground">{{ formatTime(entry.timestamp) }}</span>
        <span class="shrink-0 uppercase text-muted-foreground">{{ entry.stream }}</span>
        <span class="min-w-0" :class="entryClass(entry)">{{ entry.message }}</span>
      </div>
    </div>
  </div>
</template>
