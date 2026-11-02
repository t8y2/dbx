<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatQueryDuration } from "@/lib/format/duration";
import type { QueryResult } from "@/types/database";

const props = defineProps<{ result: QueryResult; renderMs?: number }>();
const { t } = useI18n();
const measured = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const format = (value: number | undefined) => (measured(value) ? `${Number(value.toFixed(3))}ms` : t("grid.timingUnavailable"));
const wait = computed(() => (measured(props.result.client_request_wait_ms) ? formatQueryDuration(props.result.client_request_wait_ms) : "—"));
const hasAgentTiming = computed(() => measured(props.result.query_timings_ms?.agent_total));
const phases = computed(() => {
  const m = props.result.query_timings_ms ?? {};
  const waitMs = props.result.client_request_wait_ms;
  // This is a cross-boundary remainder, not a measured network duration.
  const remainder = measured(waitMs) && measured(m.agent_total) && measured(m.core_lock) ? Math.max(0, waitMs - m.agent_total - m.core_lock) : undefined;
  const agentOther = measured(m.agent_total)
    ? Math.max(
        0,
        m.agent_total -
          Object.entries(m)
            .filter(([key]) => !["agent_total", "core_lock"].includes(key))
            .reduce((sum, [, value]) => sum + (measured(value) ? value : 0), 0),
      )
    : undefined;
  const stages = [
    { key: "prepare", value: props.result.client_prepare_ms },
    { key: "request", value: waitMs },
    { key: "core_lock", value: m.core_lock },
    { key: "pool_acquire", value: m.pool_acquire },
    { key: "session_prepare", value: m.session_prepare },
    { key: "schema", value: m.schema },
    { key: "statement_prepare", value: m.statement_prepare },
    { key: "jdbc_execute", value: m.jdbc_execute },
    { key: "metadata", value: m.metadata },
    { key: "fetch", value: m.fetch },
    { key: "pool_release", value: m.pool_release },
    { key: "agent_other", value: agentOther },
    { key: "remainder", value: remainder },
    { key: "result", value: props.result.client_result_ms },
    { key: "render", value: props.renderMs },
  ];
  return stages.filter((stage) => {
    if (["prepare", "result", "render"].includes(stage.key)) return true;
    if (stage.key === "request") return !hasAgentTiming.value;
    return hasAgentTiming.value && measured(stage.value);
  });
});
</script>

<template>
  <TooltipProvider>
    <Tooltip :delay-duration="200">
      <TooltipTrigger as-child>
        <button type="button" class="shrink-0 cursor-help rounded-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" :aria-label="t('grid.timingDetails') + ': ' + wait" data-testid="query-timing-trigger">{{ wait }}</button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" class="block max-w-sm max-h-[var(--reka-tooltip-content-available-height)] overflow-y-auto">
        <div class="space-y-2" data-testid="query-timing-details">
          <p class="font-medium">{{ t("grid.clientRequestWait", { duration: measured(result.client_request_wait_ms) ? formatQueryDuration(result.client_request_wait_ms) : t("grid.timingUnavailable") }) }}</p>
          <p v-if="(result.timing_page_count ?? 1) > 1">{{ t("grid.timingPages", { count: result.timing_page_count }) }}</p>
          <table class="w-full border-collapse text-left" :aria-label="t('grid.timingDetails')">
            <thead class="border-b border-current/20">
              <tr>
                <th scope="col" class="pb-1 pr-3 font-medium">{{ t("grid.timingNumber") }}</th>
                <th scope="col" class="pb-1 pr-4 font-medium">{{ t("grid.timingStage") }}</th>
                <th scope="col" class="pb-1 text-right font-medium">{{ t("grid.timingDuration") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(phase, index) in phases" :key="phase.key">
                <td class="py-0.5 pr-3 tabular-nums">{{ index + 1 }}.</td>
                <th scope="row" class="py-0.5 pr-4 font-normal">{{ t(`grid.timingPhase_${phase.key}`) }}</th>
                <td class="whitespace-nowrap py-0.5 text-right tabular-nums">{{ format(phase.value) }}</td>
              </tr>
            </tbody>
          </table>
          <dl v-if="hasAgentTiming" class="border-t border-current/20 pt-2">
            <div class="flex justify-between gap-4">
              <dt>{{ t("grid.timingBackend") }}</dt>
              <dd class="tabular-nums">{{ format(result.execution_time_ms) }}</dd>
            </div>
          </dl>
        </div>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
