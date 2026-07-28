<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronDown, ChevronUp, GripVertical, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { isTextContentSearchDragSource } from "@/lib/redis/redisValueSearch";

/**
 * Floating find panel (EditorSearchPanel look).
 * Uses absolute + translate (not fixed) so it works inside Reka Dialog focus traps
 * and is not clipped by dialog overflow / transform containing blocks.
 */
defineOptions({ name: "TextContentSearchBar" });

const props = withDefaults(
  defineProps<{
    modelValue: string;
    status: string;
    matchCount: number;
    showNavigation?: boolean;
    placeholder?: string;
  }>(),
  {
    showNavigation: true,
    placeholder: undefined,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  activate: [delta: -1 | 1];
  prev: [];
  next: [];
  close: [];
}>();

const { t } = useI18n();

const inputRef = ref<HTMLInputElement | null>(null);
/** Drag offset from the default top-right anchor (absolute right/top). */
const offsetX = ref(0);
const offsetY = ref(0);
const dragging = ref(false);

let dragPointerId: number | null = null;
let startClientX = 0;
let startClientY = 0;
let originX = 0;
let originY = 0;

function resolvedPlaceholder() {
  return props.placeholder ?? t("editor.search.find");
}

function onEnter(event: KeyboardEvent) {
  emit("activate", event.shiftKey ? -1 : 1);
}

function detachDragListeners() {
  window.removeEventListener("pointermove", onDragMove, true);
  window.removeEventListener("pointerup", onDragEnd, true);
  window.removeEventListener("pointercancel", onDragEnd, true);
}

function onDragMove(event: PointerEvent) {
  if (!dragging.value) return;
  if (dragPointerId != null && event.pointerId !== dragPointerId) return;
  event.preventDefault();
  offsetX.value = originX + (event.clientX - startClientX);
  offsetY.value = originY + (event.clientY - startClientY);
}

function onDragEnd(event: PointerEvent) {
  if (dragPointerId != null && event.pointerId !== dragPointerId) return;
  event.preventDefault();
  dragging.value = false;
  dragPointerId = null;
  document.body.classList.remove("dbx-search-panel-dragging");
  detachDragListeners();
}

function startDrag(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (!isTextContentSearchDragSource(event.target)) return;

  event.preventDefault();
  event.stopPropagation();

  dragging.value = true;
  dragPointerId = event.pointerId;
  startClientX = event.clientX;
  startClientY = event.clientY;
  originX = offsetX.value;
  originY = offsetY.value;
  document.body.classList.add("dbx-search-panel-dragging");

  window.addEventListener("pointermove", onDragMove, true);
  window.addEventListener("pointerup", onDragEnd, true);
  window.addEventListener("pointercancel", onDragEnd, true);

  try {
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
  } catch {
    // ignore
  }
}

function focusInput(select = true) {
  void nextTick(() => {
    const el = inputRef.value;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (select) el.select();
  });
}

onMounted(() => {
  offsetX.value = 0;
  offsetY.value = 0;
  void nextTick(() => focusInput(true));
});

onBeforeUnmount(() => {
  document.body.classList.remove("dbx-search-panel-dragging");
  detachDragListeners();
});

defineExpose({ focusInput, inputEl: inputRef });
</script>

<template>
  <div
    data-text-content-search
    data-redis-value-search
    data-draggable-search-panel
    data-search-drag-chrome
    class="dbx-text-search-panel absolute right-3 top-3 z-50 isolate flex flex-col gap-1 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl ring-1 ring-border/60"
    :class="{ 'is-dragging': dragging }"
    :style="{ transform: `translate(${offsetX}px, ${offsetY}px)` }"
    @pointerdown="startDrag"
  >
    <div class="flex items-center gap-1" data-search-drag-chrome>
      <button type="button" data-drag-handle class="dbx-search-drag-handle flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('editor.search.find')" :aria-label="t('editor.search.find')" @pointerdown="startDrag">
        <GripVertical class="pointer-events-none h-4 w-4" />
      </button>

      <div class="flex h-8 w-64 items-center rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-1 focus-within:ring-ring" data-no-drag @pointerdown.stop>
        <input
          ref="inputRef"
          data-text-content-search-input
          data-redis-value-search-input
          :value="modelValue"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          class="dbx-search-input h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          :placeholder="resolvedPlaceholder()"
          @mousedown.stop
          @pointerdown.stop
          @click.stop
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="onEnter"
          @keydown.escape.prevent.stop="emit('close')"
        />
      </div>

      <span data-search-drag-chrome class="min-w-[3.4rem] shrink-0 select-none text-center text-xs tabular-nums" :class="modelValue && matchCount === 0 ? 'text-destructive' : 'text-muted-foreground'">
        {{ status }}
      </span>

      <template v-if="showNavigation">
        <button
          type="button"
          data-no-drag
          class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          :title="t('editor.search.prevMatch')"
          :disabled="matchCount === 0"
          @pointerdown.stop
          @click="emit('prev')"
        >
          <ChevronUp class="h-4 w-4" />
        </button>
        <button
          type="button"
          data-no-drag
          class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          :title="t('editor.search.nextMatch')"
          :disabled="matchCount === 0"
          @pointerdown.stop
          @click="emit('next')"
        >
          <ChevronDown class="h-4 w-4" />
        </button>
      </template>

      <button type="button" data-no-drag class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" :title="t('editor.search.close')" @pointerdown.stop @click="emit('close')">
        <X class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.dbx-text-search-panel {
  max-width: min(calc(100vw - 2rem), 620px);
}

.dbx-search-drag-handle {
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.dbx-search-input {
  user-select: text;
  touch-action: manipulation;
  cursor: text;
}

.dbx-text-search-panel.is-dragging,
.dbx-text-search-panel.is-dragging .dbx-search-drag-handle {
  cursor: grabbing;
  user-select: none;
}
</style>

<style>
body.dbx-search-panel-dragging {
  cursor: grabbing !important;
  user-select: none !important;
}
</style>
