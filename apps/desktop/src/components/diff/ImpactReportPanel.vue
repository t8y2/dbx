<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Clock, WifiOff, Zap, Layers, CheckCircle2, XCircle } from "@lucide/vue";

const { t } = useI18n();

interface ImpactReport {
  overallRisk: "safe" | "caution" | "dangerous" | "blocked";
  ddlRiskLevel: "safe" | "caution" | "dangerous" | "blocked";
  estimatedLocks: Array<{ lockType: string; objects: string[]; duration: string }>;
  estimatedTotalDuration: string;
  recommendedStrategy: "online" | "lazy" | "offline" | "batch";
  warnings: string[];
  requiresMaintenanceWindow: boolean;
  isReversible: boolean;
}

const props = defineProps<{
  report: ImpactReport | null;
}>();

const riskColors: Record<string, string> = {
  safe: "#22c55e",
  caution: "#eab308",
  dangerous: "#f97316",
  blocked: "#ef4444",
};

const riskLabels: Record<string, string> = {
  safe: t("impact.riskSafe"),
  caution: t("impact.riskCaution"),
  dangerous: t("impact.riskDangerous"),
  blocked: t("impact.riskBlocked"),
};

const strategyIcons: Record<string, any> = {
  online: Zap,
  lazy: Clock,
  offline: WifiOff,
  batch: Layers,
};

const strategyLabels: Record<string, string> = {
  online: t("impact.strategyOnline"),
  lazy: t("impact.strategyLazy"),
  offline: t("impact.strategyOffline"),
  batch: t("impact.strategyBatch"),
};

const strategyIcon = computed(() => (props.report ? strategyIcons[props.report.recommendedStrategy] : null));
const strategyLabel = computed(() => (props.report ? strategyLabels[props.report.recommendedStrategy] : ""));
</script>

<template>
  <div class="border rounded-md bg-card">
    <!-- Header -->
    <div class="px-3 py-2 border-b">
      <h3 class="text-sm font-medium">{{ t("impact.title") }}</h3>
    </div>

    <!-- No report state -->
    <div v-if="!report" class="flex items-center justify-center py-8 text-sm text-muted-foreground">
      {{ t("impact.noReport") }}
    </div>

    <!-- Report content -->
    <div v-else class="p-3 space-y-4">
      <!-- Risk Summary -->
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2">
          <span class="text-xs text-muted-foreground">{{ t("impact.overallRisk") }}:</span>
          <span class="px-2 py-0.5 rounded text-[11px] font-semibold text-white" :style="{ backgroundColor: riskColors[report.overallRisk] }">
            {{ riskLabels[report.overallRisk] }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-muted-foreground">{{ t("impact.ddlRisk") }}:</span>
          <span class="px-2 py-0.5 rounded text-[11px] font-semibold text-white" :style="{ backgroundColor: riskColors[report.ddlRiskLevel] }">
            {{ riskLabels[report.ddlRiskLevel] }}
          </span>
        </div>
      </div>

      <!-- Strategy & Impact Grid -->
      <div class="grid grid-cols-2 gap-3">
        <div class="flex items-center gap-2 p-2 rounded border bg-muted/20">
          <component :is="strategyIcon" class="w-4 h-4 text-primary shrink-0" />
          <div class="min-w-0">
            <div class="text-[10px] text-muted-foreground">{{ t("impact.recommendedStrategy") }}</div>
            <div class="text-xs font-medium truncate">{{ strategyLabel }}</div>
          </div>
        </div>
        <div class="flex items-center gap-2 p-2 rounded border bg-muted/20">
          <Clock class="w-4 h-4 text-muted-foreground shrink-0" />
          <div class="min-w-0">
            <div class="text-[10px] text-muted-foreground">{{ t("impact.estimatedDuration") }}</div>
            <div class="text-xs font-medium truncate">{{ report.estimatedTotalDuration }}</div>
          </div>
        </div>
        <div class="flex items-center gap-2 p-2 rounded border bg-muted/20">
          <component :is="report.requiresMaintenanceWindow ? AlertTriangle : CheckCircle2" class="w-4 h-4 shrink-0" :class="report.requiresMaintenanceWindow ? 'text-amber-500' : 'text-green-500'" />
          <div class="min-w-0">
            <div class="text-[10px] text-muted-foreground">{{ t("impact.maintenanceWindow") }}</div>
            <span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium" :class="report.requiresMaintenanceWindow ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'">
              {{ report.requiresMaintenanceWindow ? t("impact.yes") : t("impact.no") }}
            </span>
          </div>
        </div>
        <div class="flex items-center gap-2 p-2 rounded border bg-muted/20">
          <component :is="report.isReversible ? CheckCircle2 : XCircle" class="w-4 h-4 shrink-0" :class="report.isReversible ? 'text-green-500' : 'text-red-500'" />
          <div class="min-w-0">
            <div class="text-[10px] text-muted-foreground">{{ t("impact.reversible") }}</div>
            <span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium" :class="report.isReversible ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'">
              {{ report.isReversible ? t("impact.yes") : t("impact.no") }}
            </span>
          </div>
        </div>
      </div>

      <!-- Lock Analysis -->
      <div v-if="report.estimatedLocks.length > 0">
        <h4 class="text-xs font-medium mb-2">{{ t("impact.lockAnalysis") }}</h4>
        <div class="border rounded overflow-hidden">
          <table class="w-full text-xs">
            <thead>
              <tr class="bg-muted/30">
                <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("impact.lockType") }}</th>
                <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("impact.lockObjects") }}</th>
                <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("impact.lockDuration") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(lock, i) in report.estimatedLocks" :key="i" class="border-t">
                <td class="px-2 py-1.5 font-mono">{{ lock.lockType }}</td>
                <td class="px-2 py-1.5">
                  <span v-for="(obj, j) in lock.objects" :key="j" class="inline-block mr-1 mb-0.5 px-1.5 py-0.5 rounded bg-muted/40 text-[10px] font-mono">
                    {{ obj }}
                  </span>
                </td>
                <td class="px-2 py-1.5 text-muted-foreground">{{ lock.duration }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Warnings -->
      <div v-if="report.warnings.length > 0">
        <h4 class="text-xs font-medium mb-2">{{ t("impact.warnings") }}</h4>
        <div class="space-y-1">
          <div v-for="(warning, i) in report.warnings" :key="i" class="flex items-start gap-2 px-2 py-1.5 rounded text-xs bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/30">
            <AlertTriangle class="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
            <span>{{ warning }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped></style>
