<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, Clock, Hourglass, Loader2, XCircle } from "@lucide/vue";

type OscExecutionStatus = "preparing" | "copying" | "cut_over" | "completed" | "failed" | "postponed";

interface OscOperation {
  toolType: "gh-ost" | "pt-osc";
  tableName: string;
  status: OscExecutionStatus;
  progressPercent: number;
  estimatedRemainingSecs?: number;
  error?: string;
}

const props = defineProps<{
  operations: OscOperation[];
}>();

const { t } = useI18n();

const statusConfig: Record<OscExecutionStatus, { labelKey: string; icon: any; badgeClass: string; barClass: string }> = {
  preparing: {
    labelKey: "osc.preparing",
    icon: Hourglass,
    badgeClass: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    barClass: "bg-yellow-500",
  },
  copying: {
    labelKey: "osc.copying",
    icon: Loader2,
    badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    barClass: "bg-blue-500",
  },
  cut_over: {
    labelKey: "osc.cutOver",
    icon: Clock,
    badgeClass: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    barClass: "bg-purple-500",
  },
  completed: {
    labelKey: "osc.completed",
    icon: CheckCircle,
    badgeClass: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    barClass: "bg-green-500",
  },
  failed: {
    labelKey: "osc.failed",
    icon: XCircle,
    badgeClass: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    barClass: "bg-red-500",
  },
  postponed: {
    labelKey: "osc.postponed",
    icon: AlertTriangle,
    badgeClass: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    barClass: "bg-orange-500",
  },
};

function formatRemaining(seconds?: number): string {
  if (seconds == null) return "-";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const toolTypeLabelKey: Record<string, string> = {
  "gh-ost": "osc.ghost",
  "pt-osc": "osc.ptosc",
};
</script>

<template>
  <div class="rounded-md border bg-card">
    <div class="border-b px-4 py-3">
      <h3 class="text-sm font-medium">{{ t("osc.title") }}</h3>
    </div>

    <div v-if="operations.length === 0" class="flex items-center justify-center px-4 py-12 text-xs text-muted-foreground">
      {{ t("osc.noActiveOsc") }}
    </div>

    <div v-else class="divide-y">
      <div v-for="op in operations" :key="`${op.toolType}-${op.tableName}`" class="px-4 py-3">
        <div class="mb-2 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <component :is="statusConfig[op.status].icon" class="h-4 w-4" :class="{ 'animate-spin': op.status === 'copying' }" />
            <span class="text-xs font-medium">{{ op.tableName }}</span>
            <Badge variant="outline" class="text-[10px]">{{ t(toolTypeLabelKey[op.toolType] || op.toolType) }}</Badge>
          </div>
          <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium" :class="statusConfig[op.status].badgeClass">
            <component :is="statusConfig[op.status].icon" class="h-3 w-3" />
            {{ t(statusConfig[op.status].labelKey) }}
          </span>
        </div>

        <div class="mb-1.5 flex items-center gap-3">
          <div class="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div class="h-full rounded-full transition-all duration-500" :class="statusConfig[op.status].barClass" :style="{ width: `${Math.min(op.progressPercent, 100)}%` }" />
          </div>
          <span class="w-10 text-right text-[10px] tabular-nums text-muted-foreground">{{ Math.min(op.progressPercent, 100) }}%</span>
        </div>

        <div class="flex items-center justify-between text-[10px] text-muted-foreground">
          <div class="flex items-center gap-1">
            <Clock class="h-3 w-3" />
            <span>{{ t("osc.estimatedRemaining") }}: {{ formatRemaining(op.estimatedRemainingSecs) }}</span>
          </div>
        </div>

        <div v-if="op.status === 'failed' && op.error" class="mt-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-[10px] text-destructive">
          <div class="flex items-start gap-1.5">
            <AlertTriangle class="mt-0.5 h-3 w-3 shrink-0" />
            <span>{{ op.error }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped></style>
