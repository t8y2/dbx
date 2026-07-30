<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check, ChevronDown, ChevronRight, RefreshCw } from "@lucide/vue";
import type { DriftAlert } from "@/types/governance";

interface DriftSummary {
  sourceEnv: string;
  targetEnv: string;
  driftCount: number;
  lastDetectedAt: string;
  hasUnacknowledged: boolean;
}

const props = defineProps<{
  drifts: DriftSummary[];
  alerts: DriftAlert[];
}>();

const emit = defineEmits<{
  acknowledge: [alertId: string];
  refresh: [];
}>();

const { t } = useI18n();
const expandedKeys = ref<Set<string>>(new Set());

const totalDriftCount = computed(() => props.drifts.reduce((sum, d) => sum + d.driftCount, 0));

function toggleKey(key: string) {
  const next = new Set(expandedKeys.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedKeys.value = next;
}

function alertsForDrift(summary: DriftSummary): DriftAlert[] {
  return props.alerts.filter((a) => a.sourceEnv === summary.sourceEnv && a.targetEnv === summary.targetEnv);
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
</script>

<template>
  <div class="rounded-md border bg-card">
    <div class="flex items-center justify-between border-b px-4 py-3">
      <h3 class="text-sm font-medium">{{ t("configDrift.title") }}</h3>
      <Button size="sm" variant="ghost" class="h-7 gap-1 text-xs" @click="emit('refresh')">
        <RefreshCw class="h-3 w-3" />
      </Button>
    </div>

    <div class="border-b px-4 py-2 text-xs">
      <template v-if="totalDriftCount > 0">
        <span class="text-muted-foreground">{{ t("configDrift.driftFound", { count: totalDriftCount }) }}</span>
      </template>
      <template v-else>
        <span class="text-muted-foreground">{{ t("configDrift.noDrift") }}</span>
      </template>
    </div>

    <div v-if="drifts.length > 0" class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead>
          <tr class="border-b bg-muted/30 text-muted-foreground">
            <th class="px-4 py-2 text-left font-medium">{{ t("configDrift.sourceEnv") }}</th>
            <th class="px-4 py-2 text-left font-medium">{{ t("configDrift.targetEnv") }}</th>
            <th class="px-4 py-2 text-left font-medium">{{ t("configDrift.driftCount") }}</th>
            <th class="px-4 py-2 text-left font-medium">{{ t("configDrift.lastDetected") }}</th>
            <th class="px-4 py-2 text-left font-medium">{{ t("configDrift.configKey") }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="drift in drifts" :key="`${drift.sourceEnv}-${drift.targetEnv}`">
            <tr class="border-b last:border-b-0 hover:bg-accent/50">
              <td class="px-4 py-2.5 font-medium">{{ drift.sourceEnv }}</td>
              <td class="px-4 py-2.5">{{ drift.targetEnv }}</td>
              <td class="px-4 py-2.5">{{ drift.driftCount }}</td>
              <td class="px-4 py-2.5 text-muted-foreground">{{ formatDate(drift.lastDetectedAt) }}</td>
              <td class="px-4 py-2.5">
                <span v-if="!drift.hasUnacknowledged" class="text-green-600 dark:text-green-400">{{ t("configDrift.acknowledged") }}</span>
                <Badge v-else variant="outline" class="text-xs">{{ t("configDrift.unacknowledged") }}</Badge>
              </td>
            </tr>

            <tr v-for="alert in alertsForDrift(drift)" :key="alert.id" class="border-b bg-muted/20">
              <td colspan="5" class="px-4 py-1.5">
                <div class="flex items-center justify-between">
                  <button class="flex items-center gap-1.5 text-left text-xs" @click="toggleKey(alert.id)">
                    <ChevronRight v-if="!expandedKeys.has(alert.id)" class="h-3 w-3 shrink-0 text-muted-foreground" />
                    <ChevronDown v-else class="h-3 w-3 shrink-0 text-muted-foreground" />
                    <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">{{ alert.configKey }}</code>
                    <span v-if="alert.acknowledged" class="text-green-600 dark:text-green-400">{{ t("configDrift.acknowledged") }}</span>
                  </button>
                  <Button v-if="!alert.acknowledged" size="sm" variant="outline" class="h-7 gap-1 text-xs" @click="emit('acknowledge', alert.id)">
                    <Check class="h-3 w-3" />
                    {{ t("configDrift.acknowledge") }}
                  </Button>
                </div>
                <div v-if="expandedKeys.has(alert.id)" class="mt-2 space-y-1.5 pl-5">
                  <div class="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <span class="text-muted-foreground">{{ t("configDrift.checksum") }} (expected)</span>
                      <code class="ml-2 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{{ alert.expectedChecksum }}</code>
                    </div>
                    <div>
                      <span class="text-muted-foreground">{{ t("configDrift.checksum") }} (actual)</span>
                      <code class="ml-2 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{{ alert.actualChecksum }}</code>
                    </div>
                  </div>
                  <div v-if="alert.detailsJson" class="text-xs">
                    <span class="text-muted-foreground">{{ t("configDrift.mismatchedFields") }}</span>
                    <pre class="mt-0.5 max-h-32 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] whitespace-pre-wrap">{{ typeof alert.detailsJson === "string" ? alert.detailsJson : JSON.stringify(alert.detailsJson, null, 2) }}</pre>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div v-if="drifts.length === 0" class="flex items-center justify-center px-4 py-10 text-xs text-muted-foreground">
      <AlertTriangle class="mr-2 h-4 w-4" />
      {{ t("configDrift.noDrift") }}
    </div>
  </div>
</template>

<style scoped></style>
