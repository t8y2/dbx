<script setup lang="ts">
import { ArrowLeft, Minus, Square, Copy, X, Grip } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useWindowControls } from "@/composables/useWindowControls";

defineProps<{
  title: string;
  dirty?: boolean;
}>();

const emit = defineEmits<{
  return: [];
  close: [];
  "drag-start": [position: { x: number; y: number }];
  dragging: [position: { x: number; y: number }];
  "drag-end": [position: { x: number; y: number }];
}>();

const { t } = useI18n();
const { isMac, isMaximized, minimize, toggleMaximize } = useWindowControls();

let dragging = false;

async function cursorPosition(event: PointerEvent) {
  // PointerEvent.screenX/Y are global screen coordinates. Convert the
  // browser's logical pixels to physical pixels so they can be compared with
  // Tauri's PhysicalPosition on the main window, including mixed-DPI setups.
  const scale = typeof window !== "undefined" && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return { x: event.screenX * scale, y: event.screenY * scale };
}

async function handleDragStart(event: PointerEvent) {
  if (event.button !== 0 || event.pointerType === "touch") return;
  event.preventDefault();
  event.stopPropagation();
  dragging = true;
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture?.(event.pointerId);
  emit("drag-start", await cursorPosition(event));
}

async function handleDragging(event: PointerEvent) {
  if (!dragging) return;
  event.preventDefault();
  emit("dragging", await cursorPosition(event));
}

async function handleDragEnd(event: PointerEvent) {
  if (!dragging) return;
  dragging = false;
  event.preventDefault();
  emit("drag-end", await cursorPosition(event));
}
</script>

<template>
  <div class="flex h-10 shrink-0 items-center border-b bg-background/95 text-xs" :class="isMac ? 'pl-20' : ''">
    <div class="flex min-w-0 flex-1 items-center gap-2 px-3" data-tauri-drag-region>
      <button
        type="button"
        class="inline-flex h-7 w-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
        :title="t('tabs.dragBackToMain')"
        @pointerdown.stop="handleDragStart"
        @pointermove.stop="handleDragging"
        @pointerup.stop="handleDragEnd"
        @pointercancel.stop="handleDragEnd"
      >
        <Grip class="h-3.5 w-3.5" />
      </button>
      <span class="min-w-0 flex-1 truncate font-medium" data-tauri-drag-region> <span v-if="dirty" class="mr-0.5">*</span>{{ title }} </span>
    </div>
    <button type="button" class="mr-1 inline-flex h-7 items-center gap-1 rounded px-2 text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('tabs.returnToMainWindow')" @pointerdown.stop @click="emit('return')">
      <ArrowLeft class="h-3.5 w-3.5" />
      <span>{{ t("tabs.returnToMainWindow") }}</span>
    </button>
    <template v-if="!isMac">
      <button type="button" class="inline-flex h-10 w-10 items-center justify-center hover:bg-foreground/10" :title="t('tabs.minimizeWindow')" @click="minimize"><Minus class="h-4 w-4" /></button>
      <button type="button" class="inline-flex h-10 w-10 items-center justify-center hover:bg-foreground/10" :title="t('tabs.maximizeWindow')" @click="toggleMaximize"><Copy v-if="isMaximized" class="h-3.5 w-3.5" /><Square v-else class="h-3.5 w-3.5" /></button>
      <button type="button" class="inline-flex h-10 w-10 items-center justify-center hover:bg-red-500 hover:text-white" :title="t('tabs.closeWindow')" @click="emit('close')"><X class="h-4 w-4" /></button>
    </template>
    <button v-else type="button" class="mr-2 inline-flex h-7 w-7 items-center justify-center rounded hover:bg-red-500 hover:text-white" :title="t('tabs.closeWindow')" @click="emit('close')"><X class="h-4 w-4" /></button>
  </div>
</template>
