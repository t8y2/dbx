<script setup lang="ts">
import { BarChart3, ListChecks } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import LightTooltip from "@/components/ui/LightTooltip.vue";

type OutputView = "result" | "summary" | "explain" | "chart";
type PrimaryResultView = Exclude<OutputView, "explain">;

const props = withDefaults(
  defineProps<{
    activeView: OutputView;
    canShowResult: boolean;
    canShowSummary: boolean;
    canShowChart: boolean;
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{
  selectView: [view: PrimaryResultView];
}>();

const { t } = useI18n();

function selectView(view: PrimaryResultView) {
  if (props.activeView === view) return;
  emit("selectView", view);
}
</script>

<template>
  <div data-query-result-view-switcher class="flex shrink-0 items-center gap-1 px-1">
    <Button size="sm" :variant="activeView === 'result' ? 'secondary' : 'ghost'" class="h-5 shrink-0 px-2 text-xs leading-none" :disabled="!canShowResult" :aria-pressed="activeView === 'result'" @click="selectView('result')">
      <span class="inline-flex h-4 items-center leading-none">{{ t("tabs.tableData") }}</span>
    </Button>

    <LightTooltip :text="t('tabs.executionSummary')" :disabled="!compact" side="bottom" :delay="0" :close-delay="0" nowrap>
      <Button
        size="sm"
        :variant="activeView === 'summary' ? 'secondary' : 'ghost'"
        class="h-5 shrink-0 text-xs leading-none"
        :class="compact ? 'w-6 gap-0 px-0' : 'gap-1 px-2'"
        :title="t('tabs.executionSummary')"
        :aria-label="t('tabs.executionSummary')"
        :aria-pressed="activeView === 'summary'"
        :disabled="!canShowSummary"
        @click="selectView('summary')"
      >
        <ListChecks class="block h-3.5 w-3.5 self-center" />
        <span v-if="!compact" class="inline-flex h-4 items-center leading-none">{{ t("tabs.executionSummary") }}</span>
      </Button>
    </LightTooltip>

    <LightTooltip :text="t('chart.title')" :disabled="!compact" side="bottom" :delay="0" :close-delay="0" nowrap>
      <Button
        size="sm"
        :variant="activeView === 'chart' ? 'secondary' : 'ghost'"
        class="h-5 shrink-0 text-xs leading-none"
        :class="compact ? 'w-6 gap-0 px-0' : 'gap-1 px-2'"
        :title="t('chart.title')"
        :aria-label="t('chart.title')"
        :aria-pressed="activeView === 'chart'"
        :disabled="!canShowChart"
        @click="selectView('chart')"
      >
        <BarChart3 class="block h-3.5 w-3.5 self-center" />
        <span v-if="!compact" class="inline-flex h-4 items-center leading-none">{{ t("chart.title") }}</span>
      </Button>
    </LightTooltip>
  </div>
</template>
