<script setup lang="ts">
// Resident session list (ADR §2.7): stopped / starting / running / stopping /
// crashed / degraded, with start / stop / restart. Sessions are supervised by
// the background worker; this view only issues requests and reflects state.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Play, RotateCcw, Square } from "@lucide/vue";
import type { ResidentSession, ResidentSessionState } from "@/lib/scheduler/schedulerTypes";

const props = defineProps<{
  sessions: readonly ResidentSession[];
  tasks: ReadonlyArray<{ id: string; name: string }>;
  busy?: boolean;
}>();

const emit = defineEmits<{
  action: [session: ResidentSession, action: "start" | "stop" | "restart"];
}>();

const { t, locale } = useI18n();

const taskNameById = computed(() => new Map(props.tasks.map((task) => [task.id, task.name])));

const stateVariant: Record<ResidentSessionState, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  starting: "secondary",
  stopping: "secondary",
  stopped: "outline",
  crashed: "destructive",
  degraded: "destructive",
};

function taskName(session: ResidentSession): string {
  return taskNameById.value.get(session.taskId) || session.taskId;
}

function formatTime(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return t("scheduler.time.notAvailable");
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="overflow-hidden rounded-md border border-border/70">
      <div v-if="sessions.length === 0" class="flex min-h-32 flex-col items-center justify-center gap-1 px-4 py-8 text-center text-muted-foreground" data-scheduler-resident-empty>
        <div class="text-sm font-medium text-foreground">{{ t("scheduler.resident.empty") }}</div>
        <p class="text-sm">{{ t("scheduler.resident.emptyHint") }}</p>
      </div>
      <div v-for="session in sessions" :key="session.id" class="grid gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center" :data-scheduler-resident-row="session.id" :data-scheduler-resident-state="session.state">
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="truncate text-sm font-medium">{{ taskName(session) }}</span>
            <Badge :variant="stateVariant[session.state] ?? 'outline'" class="font-normal">{{ t(`scheduler.resident.state.${session.state}`) }}</Badge>
          </div>
          <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{{ t("scheduler.resident.columns.heartbeat") }}: {{ formatTime(session.heartbeatAt) }}</span>
            <span>{{ t("scheduler.resident.columns.restarts") }}: {{ session.restartCount }}</span>
          </div>
        </div>
        <div class="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="busy" :title="t('scheduler.resident.start')" data-scheduler-resident-start @click="emit('action', session, 'start')">
            <Play class="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="busy" :title="t('scheduler.resident.stop')" data-scheduler-resident-stop @click="emit('action', session, 'stop')">
            <Square class="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="busy" :title="t('scheduler.resident.restart')" data-scheduler-resident-restart @click="emit('action', session, 'restart')">
            <RotateCcw class="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
