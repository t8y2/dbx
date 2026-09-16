<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch, type CSSProperties } from "vue";
import { Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import VirtualScrollArea from "@/components/common/VirtualScrollArea.vue";
import { buildTextDiff, type TextDiffKind } from "@/lib/common/textDiff";

export type TextDiffSide = "before" | "after";

const props = withDefaults(
  defineProps<{
    beforeText: string;
    afterText: string;
    beforeLabel: string;
    afterLabel: string;
    copyBeforeTitle: string;
    copyAfterTitle: string;
    beforeAvailable?: boolean;
    afterAvailable?: boolean;
  }>(),
  {
    beforeAvailable: true,
    afterAvailable: true,
  },
);

const emit = defineEmits<{
  copy: [side: TextDiffSide];
}>();

const beforeScrollArea = ref<InstanceType<typeof VirtualScrollArea> | null>(null);
const afterScrollArea = ref<InstanceType<typeof VirtualScrollArea> | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
let scrollSyncing = false;
let scrollSyncFrame = 0;

const ROW_HEIGHT = 22;
const ROW_BUFFER = 12;

const diffRows = computed(() => {
  const rows = buildTextDiff(props.beforeText, props.afterText);
  if (!props.beforeAvailable && props.afterAvailable) return rows.map((row) => ({ ...row, kind: "added" as const }));
  if (!props.afterAvailable && props.beforeAvailable) return rows.map((row) => ({ ...row, kind: "removed" as const }));
  return rows;
});
const visibleStart = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - ROW_BUFFER));
const visibleEnd = computed(() => Math.min(diffRows.value.length, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + ROW_BUFFER));
const visibleRows = computed(() => diffRows.value.slice(visibleStart.value, visibleEnd.value).map((row, offset) => ({ row, index: visibleStart.value + offset })));
const longestLineLength = computed(() => {
  let maximum = 0;
  for (const row of diffRows.value) maximum = Math.max(maximum, row.beforeText.length, row.afterText.length);
  return Math.min(20_000, maximum);
});
const textContentStyle = computed<CSSProperties>(() => ({
  height: `${Math.max(1, diffRows.value.length * ROW_HEIGHT)}px`,
  width: `max(100%, ${Math.max(40, longestLineLength.value + 8)}ch)`,
}));

function rowClass(kind: TextDiffKind, side: TextDiffSide): string {
  if (kind === "modified") return "side-by-side-text-row-modified";
  if (kind === "added" && side === "after") return "side-by-side-text-row-added";
  if (kind === "removed" && side === "before") return "side-by-side-text-row-removed";
  return "";
}

function updateViewport(element: HTMLElement) {
  scrollTop.value = element.scrollTop;
  viewportHeight.value = element.clientHeight;
}

function syncScroll(side: TextDiffSide, source: HTMLElement) {
  updateViewport(source);
  if (scrollSyncing) return;
  const target = side === "before" ? afterScrollArea.value?.scrollerElement() : beforeScrollArea.value?.scrollerElement();
  if (!target) return;
  scrollSyncing = true;
  target.scrollTop = source.scrollTop;
  target.scrollLeft = source.scrollLeft;
  if (scrollSyncFrame) cancelAnimationFrame(scrollSyncFrame);
  scrollSyncFrame = requestAnimationFrame(() => {
    scrollSyncFrame = 0;
    scrollSyncing = false;
  });
}

function onResize(element: HTMLElement) {
  viewportHeight.value = Math.max(viewportHeight.value, element.clientHeight);
}

async function resetScroll() {
  scrollTop.value = 0;
  await nextTick();
  beforeScrollArea.value?.scrollerElement()?.scrollTo({ top: 0, left: 0 });
  afterScrollArea.value?.scrollerElement()?.scrollTo({ top: 0, left: 0 });
}

watch(() => [props.beforeText, props.afterText], resetScroll);

onUnmounted(() => {
  if (scrollSyncFrame) cancelAnimationFrame(scrollSyncFrame);
});
</script>

<template>
  <div class="grid min-h-0 flex-1 grid-cols-2 overflow-hidden">
    <section class="flex min-h-0 min-w-0 flex-col border-r">
      <div class="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/20 px-2 text-[11px]">
        <span class="min-w-0 flex-1 truncate font-mono text-muted-foreground" :title="beforeLabel">{{ beforeLabel }}</span>
        <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="!beforeAvailable" :title="copyBeforeTitle" @click="emit('copy', 'before')"><Copy class="h-3 w-3" /></Button>
      </div>
      <VirtualScrollArea ref="beforeScrollArea" class="min-h-0 flex-1" scroller-class="side-by-side-text-before-scroller" @scroll="syncScroll('before', $event)" @resize="onResize">
        <div class="side-by-side-text-content" :style="textContentStyle">
          <div v-for="visible in visibleRows" :key="`before-${visible.index}`" class="side-by-side-text-row" :class="rowClass(visible.row.kind, 'before')" :style="{ top: `${visible.index * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` }">
            <span class="side-by-side-text-line-number">{{ visible.row.beforeLineNumber ?? "" }}</span>
            <code class="side-by-side-text-code"
              ><template v-for="(segment, index) in visible.row.beforeSegments" :key="index"
                ><span :class="{ 'side-by-side-text-segment-changed': segment.changed }">{{ segment.text }}</span></template
              >&nbsp;</code
            >
          </div>
        </div>
      </VirtualScrollArea>
    </section>

    <section class="flex min-h-0 min-w-0 flex-col">
      <div class="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/20 px-2 text-[11px]">
        <span class="min-w-0 flex-1 truncate font-mono text-muted-foreground" :title="afterLabel">{{ afterLabel }}</span>
        <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="!afterAvailable" :title="copyAfterTitle" @click="emit('copy', 'after')"><Copy class="h-3 w-3" /></Button>
      </div>
      <VirtualScrollArea ref="afterScrollArea" class="min-h-0 flex-1" scroller-class="side-by-side-text-after-scroller" @scroll="syncScroll('after', $event)" @resize="onResize">
        <div class="side-by-side-text-content" :style="textContentStyle">
          <div v-for="visible in visibleRows" :key="`after-${visible.index}`" class="side-by-side-text-row" :class="rowClass(visible.row.kind, 'after')" :style="{ top: `${visible.index * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` }">
            <span class="side-by-side-text-line-number">{{ visible.row.afterLineNumber ?? "" }}</span>
            <code class="side-by-side-text-code"
              ><template v-for="(segment, index) in visible.row.afterSegments" :key="index"
                ><span :class="{ 'side-by-side-text-segment-changed': segment.changed }">{{ segment.text }}</span></template
              >&nbsp;</code
            >
          </div>
        </div>
      </VirtualScrollArea>
    </section>
  </div>
</template>

<style scoped>
.side-by-side-text-content {
  position: relative;
  min-width: 100%;
  font-family: var(--font-mono);
  font-size: 12px;
}

.side-by-side-text-row {
  position: absolute;
  left: 0;
  display: flex;
  width: 100%;
  min-width: 100%;
  align-items: center;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
  line-height: 21px;
}

.side-by-side-text-line-number {
  position: sticky;
  left: 0;
  z-index: 1;
  width: 48px;
  height: 100%;
  flex: 0 0 48px;
  border-right: 1px solid var(--border);
  background: var(--background);
  padding-right: 8px;
  text-align: right;
  color: var(--muted-foreground);
  user-select: none;
}

.side-by-side-text-code {
  display: block;
  min-width: 0;
  padding: 0 8px;
  white-space: pre;
  font-family: inherit;
}

.side-by-side-text-row-modified {
  background: rgb(217 119 6 / 0.11);
}

.side-by-side-text-row-added {
  background: rgb(22 163 74 / 0.11);
}

.side-by-side-text-row-removed {
  background: rgb(220 38 38 / 0.1);
}

.side-by-side-text-row-modified .side-by-side-text-segment-changed {
  background: rgb(217 119 6 / 0.32);
}
</style>
