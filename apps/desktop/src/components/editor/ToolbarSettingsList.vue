<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { GripVertical } from "@lucide/vue";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ToolbarItemGroup, ToolbarItemKey } from "@/lib/settings/toolbarCustomization";
import { toolbarVisibilityItemLabel, type ToolbarVisibilityItem } from "@/lib/settings/settingsSearch";

const props = defineProps<{
  group: ToolbarItemGroup;
  items: ToolbarVisibilityItem[];
  order: ToolbarItemKey[];
  visibility: Partial<Record<ToolbarItemKey, boolean>>;
}>();
const emit = defineEmits<{ toggle: [key: ToolbarItemKey, visible: boolean]; reorder: [keys: ToolbarItemKey[]] }>();
const { t } = useI18n();
function getToolbarVisibilityItemLabel(item: ToolbarVisibilityItem): string {
  return toolbarVisibilityItemLabel(item, t);
}
const listRef = ref<HTMLElement>();
const orderedItems = computed(() => {
  const ranks = new Map(props.order.map((key, index) => [key, index]));
  return [...props.items].sort((a, b) => (ranks.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.key) ?? Number.MAX_SAFE_INTEGER));
});
const drag = ref<{ key: ToolbarItemKey; pointerId: number; x: number; y: number; active: boolean; handle: HTMLElement }>();
const target = ref<{ key: ToolbarItemKey; after: boolean }>();

function cancelDrag(): void {
  const previous = drag.value;
  drag.value = undefined;
  target.value = undefined;
  if (previous?.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
}

function startDrag(event: PointerEvent, key: ToolbarItemKey): void {
  if (event.button !== 0 || !event.isPrimary) return;
  cancelDrag();
  const handle = event.currentTarget as HTMLElement;
  handle.focus({ preventScroll: true });
  handle.setPointerCapture(event.pointerId);
  drag.value = { key, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false, handle };
}

function updateDrag(event: PointerEvent): void {
  const current = drag.value;
  if (!current || current.pointerId !== event.pointerId) return;
  if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
  current.active = true;
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-toolbar-setting-key]");
  const key = props.items.find((item) => item.key === row?.dataset.toolbarSettingKey)?.key;
  if (!row || !key || key === current.key || !listRef.value?.contains(row)) {
    target.value = undefined;
    return;
  }
  const rect = row.getBoundingClientRect();
  target.value = { key, after: event.clientY >= rect.top + rect.height / 2 };
}

function finishDrag(event: PointerEvent): void {
  const current = drag.value;
  if (!current || current.pointerId !== event.pointerId) return;
  updateDrag(event);
  const drop = target.value;
  if (current.active && drop) {
    const keys = orderedItems.value.map((item) => item.key).filter((key) => key !== current.key);
    const index = keys.indexOf(drop.key);
    if (index >= 0) {
      keys.splice(index + (drop.after ? 1 : 0), 0, current.key);
      emit("reorder", keys);
    }
  }
  cancelDrag();
}

function moveItem(key: ToolbarItemKey, direction: -1 | 1): void {
  const keys = orderedItems.value.map((item) => item.key);
  const from = keys.indexOf(key);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= keys.length) return;
  [keys[from], keys[to]] = [keys[to]!, keys[from]!];
  emit("reorder", keys);
}

watch(() => props.items.map((item) => item.key).join("|"), cancelDrag);
onBeforeUnmount(cancelDrag);
</script>

<template>
  <div ref="listRef" :data-toolbar-setting-group="group" class="rounded-md border p-1">
    <div v-for="item in orderedItems" :key="item.key" :data-toolbar-setting-key="item.key" class="relative flex min-h-9 select-none items-center gap-2 rounded px-2 py-1 hover:bg-muted/40" :class="{ 'opacity-40': drag?.active && drag.key === item.key }">
      <span v-if="target?.key === item.key" class="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-primary" :class="target.after ? 'bottom-0' : 'top-0'" />
      <Switch :id="`toolbar-${item.key}`" :model-value="visibility[item.key] !== false" @update:model-value="(visible: boolean) => emit('toggle', item.key, visible)" />
      <Label :for="`toolbar-${item.key}`" class="min-w-0 flex-1 cursor-pointer text-sm">{{ getToolbarVisibilityItemLabel(item) }}</Label>
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 touch-none items-center justify-center rounded text-muted-foreground hover:bg-accent"
        :class="drag?.active ? 'cursor-grabbing' : 'cursor-grab'"
        :title="t('settings.toolbarReorderItem', { item: getToolbarVisibilityItemLabel(item) })"
        :aria-label="t('settings.toolbarReorderItem', { item: getToolbarVisibilityItemLabel(item) })"
        @pointerdown.stop.prevent="startDrag($event, item.key)"
        @pointermove.stop="updateDrag"
        @pointerup.stop.prevent="finishDrag"
        @pointercancel="cancelDrag"
        @lostpointercapture="cancelDrag"
        @keydown.esc="cancelDrag"
        @keydown.up.stop.prevent="moveItem(item.key, -1)"
        @keydown.down.stop.prevent="moveItem(item.key, 1)"
        @click.stop
      >
        <GripVertical class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
