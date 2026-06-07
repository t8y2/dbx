<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  DatabaseZap,
  FilePlus2,
  Loader2,
  Languages,
  Moon,
  Sun,
  SunMoon,
  History,
  Bot,
  ArrowLeftRight,
  FileCode,
  GitCompareArrows,
  TableProperties,
  Settings,
  CloudDownload,
  Package,
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import WindowControls from "@/components/layout/WindowControls.vue";
import ExportProgressPopover from "@/components/export/ExportProgressPopover.vue";
import { shouldReserveMacTrafficLightInset, useWindowControls } from "@/composables/useWindowControls";
import { currentLocale, setLocale, type Locale } from "@/i18n";
import type { AppThemeMode } from "@/lib/appTheme";
import { LOCALE_OPTIONS } from "@/lib/localeOptions";

const props = defineProps<{
  isDark: boolean;
  themeMode: AppThemeMode;
  showAiPanel: boolean;
  showHistory: boolean;
  showDriverStore: boolean;
  checkingUpdates: boolean;
  hasUpdateAvailable: boolean;
  agentDriverUpdateCount: number;
  hasConnections: boolean;
  hasSqlFileConnections: boolean;
}>();

const emit = defineEmits<{
  "new-connection": [];
  "new-query": [];
  "set-theme-mode": [mode: AppThemeMode];
  "toggle-ai": [];
  "toggle-history": [];
  "open-github": [];
  "open-settings": [];
  "open-driver-store": [];
  "check-updates": [];
  "open-transfer": [];
  "open-sql-file": [];
  "open-schema-diff": [];
  "open-data-compare": [];
}>();

const { t } = useI18n();
const { isMac, isDesktop, showControls, isMaximized, isFullscreen, minimize, toggleMaximize, close } =
  useWindowControls();

const themeItems = computed(() => [
  { value: "light", label: t("toolbar.themeLight"), icon: Sun },
  { value: "dark", label: t("toolbar.themeDark"), icon: Moon },
  { value: "system", label: t("toolbar.themeSystem"), icon: SunMoon },
]);
const localeItems = computed(() =>
  LOCALE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    leadingText: option.flag,
  })),
);
const themeTriggerIcon = computed(() => {
  if (props.themeMode === "system") return SunMoon;
  return props.isDark ? Moon : Sun;
});

function onToolbarDblClick(e: MouseEvent) {
  if (isDesktop) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, [role='button'], a")) return;
  toggleMaximize();
}
</script>

<template>
  <div
    class="h-10 flex items-center gap-1 px-2 border-b bg-muted/30 shrink-0"
    :class="{ 'pl-17.5': shouldReserveMacTrafficLightInset(isMac, isFullscreen, isDesktop) }"
    data-tauri-drag-region
    @dblclick="onToolbarDblClick"
  >
    <Button variant="ghost" size="sm" class="h-8 px-2 text-xs gap-1" @click="emit('new-connection')">
      <DatabaseZap class="h-3.5 w-3.5" />
      {{ t("toolbar.newConnection") }}
    </Button>

    <Button
      variant="ghost"
      size="sm"
      class="h-8 px-2 text-xs gap-1"
      @click="emit('new-query')"
      :disabled="!hasConnections"
    >
      <FilePlus2 class="h-3.5 w-3.5" />
      {{ t("toolbar.newQuery") }}
    </Button>

    <Button
      variant="ghost"
      size="sm"
      class="h-8 px-2 text-xs gap-1"
      @click="emit('open-transfer')"
      :disabled="!hasConnections"
    >
      <ArrowLeftRight class="h-3.5 w-3.5" />
      {{ t("transfer.dataTransfer") }}
    </Button>

    <Button
      variant="ghost"
      size="sm"
      class="h-8 px-2 text-xs gap-1"
      @click="emit('open-sql-file')"
      :disabled="!hasSqlFileConnections"
    >
      <FileCode class="h-3.5 w-3.5" />
      {{ t("sqlFile.title") }}
    </Button>

    <Button
      variant="ghost"
      size="sm"
      class="h-8 px-2 text-xs gap-1"
      @click="emit('open-schema-diff')"
      :disabled="!hasConnections"
    >
      <GitCompareArrows class="h-3.5 w-3.5" />
      {{ t("diff.title") }}
    </Button>

    <Button
      variant="ghost"
      size="sm"
      class="h-8 px-2 text-xs gap-1"
      @click="emit('open-data-compare')"
      :disabled="!hasConnections"
    >
      <TableProperties class="h-3.5 w-3.5" />
      {{ t("dataCompare.title") }}
    </Button>

    <Button
      variant="ghost"
      size="sm"
      class="h-8 px-2 text-xs gap-1"
      :class="{ 'bg-accent': showDriverStore }"
      @click="emit('open-driver-store')"
    >
      <Package class="h-3.5 w-3.5" />
      {{ t("toolbar.driverManager") }}
      <span
        v-if="agentDriverUpdateCount > 0"
        class="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white"
        :aria-label="t('toolbar.updatableDriverCount')"
      >
        {{ agentDriverUpdateCount > 99 ? "99+" : agentDriverUpdateCount }}
      </span>
    </Button>

    <div class="flex-1" data-tauri-drag-region />

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="relative h-8 w-8"
          :disabled="checkingUpdates"
          @click="emit('check-updates')"
        >
          <Loader2 v-if="checkingUpdates" class="h-4 w-4 animate-spin" />
          <CloudDownload v-else class="h-4 w-4" />
          <span
            v-if="hasUpdateAvailable"
            class="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-background"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ t("updates.check") }}</TooltipContent>
    </Tooltip>

    <ExportProgressPopover />

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="h-8 w-8"
          :class="{ 'bg-accent': showHistory }"
          @click="emit('toggle-history')"
        >
          <History class="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ t("history.title") }}</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="h-8 w-8"
          :class="{ 'bg-accent': showAiPanel }"
          @click="emit('toggle-ai')"
        >
          <Bot class="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>AI</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <span class="inline-flex">
          <LightDropdown
            :model-value="themeMode"
            :items="themeItems"
            :aria-label="t('toolbar.theme')"
            :trigger-icon="themeTriggerIcon"
            trigger-class="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
            trigger-icon-class="h-4 w-4"
            item-icon-class="h-4 w-4"
            :show-trigger-label="false"
            :show-chevron="false"
            check-position="right"
            align="end"
            @update:model-value="(value) => emit('set-theme-mode', value as AppThemeMode)"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{{ t("toolbar.theme") }}</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <span class="inline-flex">
          <LightDropdown
            :model-value="currentLocale()"
            :items="localeItems"
            :aria-label="t('common.language')"
            :trigger-icon="Languages"
            trigger-class="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
            trigger-icon-class="h-4 w-4"
            :show-trigger-label="false"
            :show-chevron="false"
            check-position="none"
            align="end"
            @update:model-value="(value) => setLocale(value as Locale)"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{{ t("common.language") }}</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon" class="h-8 w-8" @click="emit('open-github')">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <path
              d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12 24 5.37 18.627 0 12 0z"
            />
          </svg>
        </Button>
      </TooltipTrigger>
      <TooltipContent>GitHub</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon" class="h-8 w-8" @click="emit('open-settings')">
          <Settings class="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ t("settings.title") }}</TooltipContent>
    </Tooltip>

    <WindowControls
      v-if="showControls"
      :is-maximized="isMaximized"
      @minimize="minimize"
      @toggle-maximize="toggleMaximize"
      @close="close"
    />
  </div>
</template>
