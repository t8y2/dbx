<script setup lang="ts">
import { computed, ref } from "vue";
import { GitBranch, Gauge, Loader2, PlugZap, Upload } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import * as api from "@/lib/backend/api";
import { createFrontendPluginRegistry, type PluginContributionEntry } from "@/lib/plugins/frontendPlugin";
import type { InstalledPlugin, PluginResultViewContribution } from "@/types/database";

type OutputView = "result" | "summary" | "explain" | "chart" | "messages" | "profile";

const props = withDefaults(
  defineProps<{
    activeView: OutputView;
    canShowExplain: boolean;
    canShowProfile: boolean;
    canExportArchive: boolean;
    archiveExporting: boolean;
    compact?: boolean;
    hasResult?: boolean;
  }>(),
  { compact: false, hasResult: false },
);

const emit = defineEmits<{
  selectExplain: [];
  selectProfile: [];
  exportArchive: [];
  openResultView: [pluginId: string, contributionId: string, label: string];
}>();

const { t, locale: appLocale } = useI18n();

const installedPlugins = ref<InstalledPlugin[]>([]);
const resultViews = computed<PluginContributionEntry<PluginResultViewContribution>[]>(() => createFrontendPluginRegistry(installedPlugins.value, appLocale.value).listResultViews());
const visibleResultViews = computed(() => (props.hasResult ? resultViews.value.slice(0, 4) : []));

void api.listPlugins().then(
  (plugins) => {
    installedPlugins.value = plugins.filter((plugin) => plugin.compatibility.compatible);
  },
  () => {},
);
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

    <LightTooltip v-if="canShowProfile" :text="t('profile.title')" :disabled="!compact" side="bottom" :delay="0" :close-delay="0" nowrap>
      <Button
        size="sm"
        :variant="activeView === 'profile' ? 'secondary' : 'ghost'"
        class="h-5 shrink-0 text-xs leading-none"
        :class="compact ? 'w-6 gap-0 px-0' : 'gap-1 px-2'"
        :title="t('profile.title')"
        :aria-label="t('profile.title')"
        :aria-pressed="activeView === 'profile'"
        @click="emit('selectProfile')"
      >
        <Gauge class="block h-3.5 w-3.5 self-center" />
        <span v-if="!compact" class="inline-flex h-4 items-center leading-none">{{ t("profile.title") }}</span>
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
    <LightTooltip v-for="view in visibleResultViews" :key="view.plugin.manifest.id + ':' + view.contribution.id" :text="t('pluginPlatform.openResultView', { label: view.contribution.label })" :disabled="!compact" side="bottom" :delay="0" :close-delay="0" nowrap>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 shrink-0 text-xs leading-none text-muted-foreground hover:text-foreground"
        :class="compact ? 'w-6 gap-0 px-0' : 'gap-1 px-2'"
        :title="t('pluginPlatform.openResultView', { label: view.contribution.label })"
        :aria-label="t('pluginPlatform.openResultView', { label: view.contribution.label })"
        @click="emit('openResultView', view.plugin.manifest.id, view.contribution.id, view.contribution.label)"
      >
        <PlugZap class="block h-3.5 w-3.5 self-center" />
        <span v-if="!compact" class="inline-flex h-4 items-center leading-none">{{ view.contribution.label }}</span>
      </Button>
    </LightTooltip>
  </div>
</template>
