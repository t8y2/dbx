<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import PluginIcon from "./PluginIcon.vue";
import { usePluginShortcuts } from "@/composables/usePluginShortcuts";
import { usePluginShortcutPreferences } from "@/composables/usePluginShortcutPreferences";
import { usePluginShortcutSort } from "@/composables/usePluginShortcutSort";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { movePluginShortcut, pluginShortcutToolbarCount, pluginShortcutToolbarWidth, type PluginShortcutEntry } from "@/lib/plugins/pluginShortcuts";

const props = defineProps<{ dropdownOnly?: boolean; menuAnchor?: HTMLElement | null }>();
const emit = defineEmits<{ "layout-change": [] }>();
const { t } = useI18n();
const settings = useSettingsStore();
const { toast } = useToast();
const { entries, open, isActive } = usePluginShortcuts();
const { update, saving } = usePluginShortcutPreferences();
const root = ref<HTMLElement | null>(null);
const menuList = ref<HTMLElement | null>(null);
const moreTrigger = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
const measuredWidth = ref<number | null>(null);
const requested = computed(() => (props.dropdownOnly ? 0 : settings.editorSettings.pluginShortcuts.toolbarCount));
const preferredWidth = computed(() => pluginShortcutToolbarWidth(entries.value.length, requested.value));
const count = computed(() => pluginShortcutToolbarCount(entries.value.length, requested.value, measuredWidth.value ?? preferredWidth.value));
const inlineEntries = computed(() => entries.value.slice(0, count.value));
const overflowEntries = computed(() => entries.value.slice(count.value));
const ids = computed(() => entries.value.map((entry) => entry.id));
const sorting = usePluginShortcutSort({
  container: root,
  extraContainers: computed(() => (menuList.value ? [menuList.value] : [])),
  horizontal: ref(true),
  ids,
  disabled: saving,
  commit: async (source, target, after) => {
    try {
      await update((current) => ({ order: movePluginShortcut(current.order, ids.value, source, target, after) }));
    } catch (error) {
      toast(`${t("pluginPlatform.shortcutsSaveFailed")}: ${String(error)}`, 5000);
    }
  },
});
const { drag } = sorting;
const draggedEntry = computed(() => entries.value.find((entry) => entry.id === drag.source));
let observer: ResizeObserver | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
function clearHoverTimer() {
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  hoverTimer = null;
}
function measure() {
  measuredWidth.value = root.value?.offsetWidth ?? null;
  emit("layout-change");
}
watch(
  root,
  (element) => {
    observer?.disconnect();
    if (element && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(element);
    }
    measure();
  },
  { flush: "post" },
);
watch(preferredWidth, () => void nextTick(measure));
watch(overflowEntries, (entries) => {
  if (!entries.length) menuOpen.value = false;
});
watch(menuOpen, (open) => {
  if (!open) sorting.cancel();
});
// A held icon over the arrow opens the menu, allowing moves across the inline/menu boundary.
watch(
  () => [drag.active, drag.x, drag.y] as const,
  () => {
    const bounds = moreTrigger.value?.getBoundingClientRect();
    const hovering = drag.active && !menuOpen.value && bounds && drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom;
    if (!hovering) {
      clearHoverTimer();
      return;
    }
    if (hoverTimer === null)
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        if (drag.active) menuOpen.value = true;
      }, 350);
  },
);
function outside(event: CustomEvent<{ originalEvent: Event }>) {
  if (drag.active || (event.detail.originalEvent.target instanceof Node && root.value?.contains(event.detail.originalEvent.target))) event.preventDefault();
}
function preventDragFocus(event: Event) {
  if (drag.active) event.preventDefault();
}
function activate(entry: PluginShortcutEntry, event?: Event) {
  if (sorting.suppressClick()) {
    event?.preventDefault();
    return;
  }
  try {
    open(entry);
    menuOpen.value = false;
  } catch (error) {
    toast(String(error), 5000);
  }
}
onScopeDispose(() => {
  observer?.disconnect();
  clearHoverTimer();
});
</script>

<template>
  <nav
    v-if="settings.isEditorSettingsLoaded && entries.length"
    ref="root"
    data-plugin-shortcut-toolbar
    :aria-label="t('pluginPlatform.shortcutsTitle')"
    class="shortcut-toolbar flex h-8 items-center"
    :class="dropdownOnly ? 'shrink-0' : 'min-w-[34px] shrink gap-0.5 rounded-md border border-border/70 bg-background/80 px-0.5 py-0 shadow-xs'"
    :style="dropdownOnly ? undefined : { width: `${preferredWidth}px` }"
    @dragstart.prevent
  >
    <LightTooltip v-for="entry in inlineEntries" :key="entry.id" :text="entry.label" :disabled="drag.active || menuOpen" side="bottom" content-class="shortcut-toolbar-tooltip">
      <span
        class="shortcut-inline-item relative flex shrink-0 touch-none"
        :data-shortcut-id="entry.id"
        :class="{ 'drop-before': drag.target === entry.id && !drag.after && drag.source !== entry.id, 'drop-after': drag.target === entry.id && drag.after && drag.source !== entry.id, 'opacity-40': drag.active && drag.source === entry.id }"
        @pointerdown="sorting.start($event, entry.id)"
      >
        <Button variant="ghost" size="icon" class="shortcut-toolbar-button relative size-7 shrink-0" :class="{ 'bg-accent text-accent-foreground': isActive(entry) }" :aria-label="entry.label" :aria-pressed="isActive(entry)" :disabled="entry.disabled" @click="activate(entry)">
          <PluginIcon :plugin-id="entry.pluginId" :icon="entry.icon" class="size-4 [&_svg]:text-current [&_img]:pointer-events-none" />
          <span v-if="isActive(entry)" class="absolute bottom-0 h-0.5 w-3 rounded-full bg-primary" aria-hidden="true" />
        </Button>
      </span>
    </LightTooltip>
    <DropdownMenu v-if="overflowEntries.length" v-model:open="menuOpen" :modal="false">
      <span ref="moreTrigger" class="flex shrink-0">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="shortcut-toolbar-button shrink-0" :class="[dropdownOnly ? 'h-8 w-7 rounded-l-none' : 'size-7', { 'bg-accent text-accent-foreground': menuOpen }]" :aria-label="t('pluginPlatform.shortcutsMore', { count: overflowEntries.length })">
            <ChevronDown class="size-3.5 transition-transform" :class="{ 'rotate-180': menuOpen }" />
          </Button>
        </DropdownMenuTrigger>
      </span>
      <DropdownMenuContent :reference="dropdownOnly ? (menuAnchor ?? undefined) : undefined" :align="dropdownOnly ? 'start' : 'end'" :side-offset="dropdownOnly ? 4 : 8" class="w-60 max-w-[calc(100vw-16px)] p-1" @interact-outside="outside" @open-auto-focus="preventDragFocus" @dragstart.prevent>
        <div ref="menuList" data-plugin-shortcut-overflow class="max-h-[min(320px,var(--reka-dropdown-menu-content-available-height))] overflow-y-auto overflow-x-hidden">
          <DropdownMenuItem
            v-for="entry in overflowEntries"
            :key="entry.id"
            :data-shortcut-id="entry.id"
            :text-value="entry.label"
            :disabled="entry.disabled"
            class="shortcut-menu-item relative min-h-8 touch-none gap-2 rounded-sm text-xs"
            :class="{ 'bg-accent text-accent-foreground': isActive(entry), 'drop-before': drag.target === entry.id && !drag.after && drag.source !== entry.id, 'drop-after': drag.target === entry.id && drag.after && drag.source !== entry.id, 'opacity-40': drag.active && drag.source === entry.id }"
            @pointerdown="sorting.start($event, entry.id)"
            @select="activate(entry, $event)"
          >
            <PluginIcon :plugin-id="entry.pluginId" :icon="entry.icon" class="size-4 shrink-0 [&_svg]:text-current [&_img]:pointer-events-none" />
            <span class="min-w-0 flex-1 truncate" :title="entry.label">{{ entry.label }}</span>
            <span v-if="isActive(entry)" class="size-1.5 shrink-0 rounded-full bg-green-500" aria-hidden="true" />
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
    <Teleport to="body">
      <div v-if="drag.active" class="fixed inset-0 z-[2147483646] cursor-grabbing touch-none select-none" aria-hidden="true" />
      <div
        v-if="drag.active && draggedEntry"
        class="pointer-events-none fixed z-[2147483647] flex max-w-xs items-center gap-2 rounded-md border border-primary/50 bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md"
        :style="{ left: `${drag.x + 12}px`, top: `${drag.y + 12}px` }"
        aria-hidden="true"
      >
        <PluginIcon :plugin-id="draggedEntry.pluginId" :icon="draggedEntry.icon" class="size-4 [&_svg]:text-current" />
        <span class="truncate">{{ draggedEntry.label }}</span>
      </div>
    </Teleport>
  </nav>
</template>

<style scoped>
.shortcut-toolbar-button {
  border: 1px solid transparent;
  color: var(--muted-foreground);
}
.shortcut-toolbar-button:hover,
.shortcut-toolbar-button[aria-pressed="true"] {
  background: color-mix(in srgb, var(--primary) 14%, var(--background));
  border-color: color-mix(in srgb, var(--primary) 40%, transparent);
  color: var(--foreground);
}
.drop-before::before,
.drop-after::after {
  content: "";
  position: absolute;
  background: var(--primary);
  pointer-events: none;
  z-index: 1;
}
.shortcut-inline-item.drop-before::before {
  width: 2px;
  inset: 2px auto 2px -2px;
}
.shortcut-inline-item.drop-after::after {
  width: 2px;
  inset: 2px -2px 2px auto;
}
.shortcut-menu-item.drop-before::before {
  height: 2px;
  inset: 0 2px auto;
}
.shortcut-menu-item.drop-after::after {
  height: 2px;
  inset: auto 2px 0;
}
</style>
<style>
.shortcut-toolbar-tooltip {
  width: max-content;
  max-width: calc(100vw - 24px);
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
