<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { BetweenHorizontalStart, TextSearch, Wand2 } from "@lucide/vue";
import LightDropdownMenu, { type LightDropdownMenuItem } from "@/components/ui/LightDropdownMenu.vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import type { SidebarSearchMatchMode } from "@/lib/sidebar/sidebarSearch";

const props = defineProps<{
  modelValue: SidebarSearchMatchMode;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [mode: SidebarSearchMatchMode];
}>();

const { t } = useI18n();

const MODE_ICONS = {
  fuzzy: Wand2,
  contains: TextSearch,
  edges: BetweenHorizontalStart,
} as const;

const MODE_LABEL_KEYS = {
  fuzzy: "sidebar.searchMatchModeFuzzy",
  contains: "sidebar.searchMatchModeContains",
  edges: "sidebar.searchMatchModeEdges",
} as const;

const modes: SidebarSearchMatchMode[] = ["fuzzy", "contains", "edges"];

const items = computed<LightDropdownMenuItem[]>(() =>
  modes.map((mode) => ({
    label: t(MODE_LABEL_KEYS[mode]),
    value: mode,
    icon: MODE_ICONS[mode],
    // `checked` binds the checkmark to the prop instead of the dropdown's own
    // single-value bookkeeping, so a parent reset is reflected immediately.
    checked: mode === props.modelValue,
    // One-of-three choice: announce it as a radio option with its state.
    role: "menuitemradio",
  })),
);

const activeIcon = computed(() => MODE_ICONS[props.modelValue]);
const activeModeLabel = computed(() => t(MODE_LABEL_KEYS[props.modelValue]));
</script>

<template>
  <LightDropdownMenu
    :items="items"
    align="end"
    :match-trigger-width="false"
    :disabled="disabled"
    content-class="w-max min-w-0"
    selected-item-class="bg-primary/10 text-primary"
    selected-check-class="text-primary"
    item-icon-class="h-3.5 w-3.5"
    @select="(mode: string) => emit('update:modelValue', mode as SidebarSearchMatchMode)"
  >
    <template #trigger="{ open, toggle }">
      <LightTooltip :text="`${activeModeLabel} — ${t('sidebar.searchMatchModeTooltip')}`" side="top" :delay="300">
        <button
          type="button"
          data-sidebar-search-match-mode-trigger
          :data-sidebar-search-match-mode="modelValue"
          class="relative flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm px-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          :class="{ 'bg-accent text-foreground': open }"
          :aria-label="`${t('sidebar.searchMatchMode')}: ${activeModeLabel}`"
          aria-haspopup="menu"
          :aria-expanded="open"
          :disabled="disabled"
          @click.stop="toggle"
        >
          <component :is="activeIcon" class="h-3.5 w-3.5" />
        </button>
      </LightTooltip>
    </template>
  </LightDropdownMenu>
</template>
