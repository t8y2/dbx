<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowUpRight, Loader2, Pencil, X } from "@lucide/vue";
import ForeignKeyCardContent from "./ForeignKeyCardContent.vue";

export interface ForeignKeyCardAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const props = defineProps<{
  anchor: ForeignKeyCardAnchor;
  table: string;
  loading: boolean;
  error?: string;
  empty?: boolean;
  html: string;
  /** 点击模式：点击卡片外部或按 Esc 关闭；悬停模式由 DataGrid 根据指针位置控制。 */
  dismissOnOutsideClick: boolean;
}>();
const emit = defineEmits<{ close: []; edit: []; navigate: []; pointerenter: []; pointerleave: [] }>();

const { t } = useI18n();
const cardRef = ref<HTMLDivElement | null>(null);
const cardSize = ref({ width: 320, height: 160 });

const CARD_WIDTH = 320;
const GAP = 6;
const MARGIN = 8;

const cardStyle = computed(() => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const height = cardSize.value.height;
  const below = props.anchor.bottom + GAP;
  const top = below + height + MARGIN <= viewportHeight || props.anchor.top - GAP - height < MARGIN ? below : props.anchor.top - GAP - height;
  const left = Math.min(props.anchor.left, viewportWidth - CARD_WIDTH - MARGIN);
  return { left: `${Math.max(MARGIN, left)}px`, top: `${Math.max(MARGIN, top)}px`, width: `${CARD_WIDTH}px` };
});

let resizeObserver: ResizeObserver | null = null;
watch(cardRef, (element) => {
  resizeObserver?.disconnect();
  if (!element || typeof ResizeObserver === "undefined") return;
  resizeObserver = new ResizeObserver(() => {
    cardSize.value = { width: element.offsetWidth, height: element.offsetHeight };
  });
  resizeObserver.observe(element);
});

function onDocumentPointerDown(event: PointerEvent) {
  if (!props.dismissOnOutsideClick) return;
  const target = event.target;
  if (target instanceof Node && cardRef.value?.contains(target)) return;
  if (target instanceof Element && target.closest("[data-foreign-key-card-toggle]")) return;
  emit("close");
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}

document.addEventListener("pointerdown", onDocumentPointerDown, true);
document.addEventListener("keydown", onDocumentKeydown);
onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onDocumentKeydown);
  resizeObserver?.disconnect();
});
</script>

<template>
  <Teleport to="body">
    <div ref="cardRef" class="fixed z-[60] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg" :style="cardStyle" data-foreign-key-card @pointerenter="emit('pointerenter')" @pointerleave="emit('pointerleave')" @mousedown.stop>
      <div class="flex h-8 items-center gap-1 border-b bg-muted/30 pl-3 pr-1 text-xs">
        <span class="min-w-0 flex-1 truncate font-medium text-muted-foreground">{{ table }}</span>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" :title="t('grid.foreignKeyCardEdit')" @click="emit('edit')">
          <Pencil class="h-3.5 w-3.5" />
        </button>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" :title="t('grid.foreignKeyNavigate', { table })" @click="emit('navigate')">
          <ArrowUpRight class="h-3.5 w-3.5" />
        </button>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" :title="t('grid.foreignKeyCardClose')" @click="emit('close')">
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
      <div class="max-h-[360px] overflow-auto p-3">
        <div v-if="loading" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
          {{ t("grid.foreignKeyCardLoading") }}
        </div>
        <p v-else-if="error" class="break-all text-xs text-destructive">{{ error }}</p>
        <p v-else-if="empty" class="py-2 text-xs text-muted-foreground">{{ t("grid.foreignKeyCardNotFound") }}</p>
        <ForeignKeyCardContent v-else :html="html" />
      </div>
    </div>
  </Teleport>
</template>
