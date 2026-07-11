<script setup lang="ts">
import { GitBranch, Loader2, Upload } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import LightTooltip from "@/components/ui/LightTooltip.vue";

type OutputView = "result" | "summary" | "explain" | "chart";

withDefaults(
  defineProps<{
    activeView: OutputView;
    canShowExplain: boolean;
    canExportArchive: boolean;
    archiveExporting: boolean;
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{
  selectExplain: [];
  exportArchive: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div data-query-result-toolbar-actions class="flex shrink-0 items-center gap-1 border-r px-1">
    <LightTooltip :text="t('explain.title')" :disabled="!compact" side="bottom" :delay="0" :close-delay="0" nowrap>
      <Button
        size="sm"
        :variant="activeView === 'explain' ? 'secondary' : 'ghost'"
        class="h-5 shrink-0 text-xs leading-none"
        :class="compact ? 'w-6 gap-0 px-0' : 'gap-1 px-2'"
        :title="t('explain.title')"
        :aria-label="t('explain.title')"
        :aria-pressed="activeView === 'explain'"
        :disabled="!canShowExplain"
        @click="emit('selectExplain')"
      >
        <GitBranch class="block h-3.5 w-3.5 self-center" />
        <span v-if="!compact" class="inline-flex h-4 items-center leading-none">{{ t("explain.title") }}</span>
      </Button>
    </LightTooltip>

    <LightTooltip v-if="canExportArchive" :text="t('tabs.exportResultArchive')" :disabled="!compact" side="bottom" :delay="0" :close-delay="0" nowrap>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 shrink-0 text-xs leading-none text-muted-foreground hover:text-foreground"
        :class="compact ? 'w-6 gap-0 px-0' : 'gap-1 px-2'"
        :title="t('tabs.exportResultArchive')"
        :aria-label="t('tabs.exportResultArchive')"
        :aria-busy="archiveExporting"
        :disabled="archiveExporting"
        @click="emit('exportArchive')"
      >
        <Loader2 v-if="archiveExporting" class="block h-3.5 w-3.5 self-center animate-spin" />
        <Upload v-else class="block h-3.5 w-3.5 self-center" />
        <span v-if="!compact" class="inline-flex h-4 items-center leading-none">{{ t("tabs.exportResultArchive") }}</span>
      </Button>
    </LightTooltip>
  </div>
</template>
