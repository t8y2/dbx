<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { SqlFileProgress } from "@/lib/backend/tauri";
import { formatSqlFileBytes, sqlFileProgressPercent } from "@/lib/sql/sqlFileProgress";

const props = defineProps<{
  status: string;
  bytesRead?: number;
  totalBytes?: number;
  phase?: SqlFileProgress["phase"];
}>();
const { t } = useI18n();
const normalizedStatus = computed(() => props.status.toLowerCase());
const active = computed(() => !["done", "error", "cancelled", "idle"].includes(normalizedStatus.value));
const percent = computed(() => sqlFileProgressPercent(props.status, props.bytesRead, props.totalBytes));
const phaseLabel = computed(() => {
  if (!active.value) return t("sqlFile.byteProgress");
  const phase = props.phase ?? (normalizedStatus.value === "started" ? "preparing" : "executing");
  return t(`sqlFile.progressPhase.${phase}`);
});
const byteLabel = computed(() => {
  if (props.bytesRead === undefined || !Number.isFinite(props.bytesRead)) return "";
  const read = formatSqlFileBytes(props.bytesRead);
  return props.totalBytes === undefined || !Number.isFinite(props.totalBytes) ? t("sqlFile.bytesRead", { read }) : t("sqlFile.bytesReadOfTotal", { read, total: formatSqlFileBytes(props.totalBytes) });
});
</script>

<template>
  <div class="min-w-0 space-y-1.5 text-xs" data-testid="sql-file-progress" :title="t('sqlFile.byteProgressHint')">
    <div class="flex items-center justify-between gap-2 text-muted-foreground">
      <span class="truncate">{{ phaseLabel }}</span>
      <span v-if="percent !== null" class="shrink-0 tabular-nums">{{ percent }}%</span>
    </div>
    <div role="progressbar" :aria-label="t('sqlFile.byteProgress')" :aria-valuenow="percent ?? undefined" :aria-valuemin="0" :aria-valuemax="100" class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div v-if="percent === null && active" class="sql-file-progress-indeterminate h-full rounded-full bg-primary" />
      <div v-else class="h-full rounded-full transition-[width] duration-300" :class="normalizedStatus === 'error' ? 'bg-destructive' : normalizedStatus === 'cancelled' ? 'bg-yellow-500' : normalizedStatus === 'done' ? 'bg-green-500' : 'bg-primary'" :style="{ width: `${percent ?? 0}%` }" />
    </div>
    <div v-if="byteLabel" class="break-words text-muted-foreground tabular-nums">{{ byteLabel }}</div>
  </div>
</template>

<style scoped>
.sql-file-progress-indeterminate {
  width: 40%;
  animation: sql-file-progress-slide 1.15s ease-in-out infinite;
}

@keyframes sql-file-progress-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}
</style>
