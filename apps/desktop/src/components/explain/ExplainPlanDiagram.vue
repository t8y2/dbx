<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDownWideNarrow, CircleHelp, GitMerge, KeyRound, Layers, ListTree, Maximize2, MonitorCheck, Pencil, Sigma, Split, Table2, ZoomIn, ZoomOut } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { ExplainPlanNode } from "@/lib/diagram/explainPlan";
import type { PlanCanvasCategory, PlanCanvasNode } from "@/lib/diagram/planCanvas";
import { buildPlanCanvas, edgeStrokeWidth, formatPlanRows, heatLevel, PLAN_CANVAS_GAP_X, PLAN_CANVAS_NODE_H, PLAN_CANVAS_NODE_W } from "@/lib/diagram/planCanvas";

const props = defineProps<{
  nodes: ExplainPlanNode[];
}>();

const { t } = useI18n();

const CATEGORY_COLORS: Record<PlanCanvasCategory, string> = {
  result: "#a78bfa",
  sort: "#38bdf8",
  join: "#f472b6",
  tscan: "#fb923c",
  iscan: "#34d399",
  lookup: "#2dd4bf",
  mat: "#94a3b8",
  agg: "#c084fc",
  xchg: "#facc15",
  mod: "#f87171",
  other: "var(--muted-foreground)",
};

const CATEGORY_ICONS = {
  result: MonitorCheck,
  sort: ArrowDownWideNarrow,
  join: GitMerge,
  tscan: Table2,
  iscan: ListTree,
  lookup: KeyRound,
  mat: Layers,
  agg: Sigma,
  xchg: Split,
  mod: Pencil,
  other: CircleHelp,
} as const;

const CATEGORY_LABEL_KEYS: Record<PlanCanvasCategory, string> = {
  result: "explain.catResult",
  sort: "explain.catSort",
  join: "explain.catJoin",
  tscan: "explain.catTscan",
  iscan: "explain.catIscan",
  lookup: "explain.catLookup",
  mat: "explain.catMat",
  agg: "explain.catAgg",
  xchg: "explain.catXchg",
  mod: "explain.catMod",
  other: "explain.catOther",
};

const HEAT_COLORS = {
  none: "var(--muted-foreground)",
  cool: "#22c55e",
  warm: "#f59e0b",
  hot: "#ef4444",
} as const;

const HEAT_BADGE_CLASSES = {
  none: "bg-muted text-muted-foreground",
  cool: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  warm: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  hot: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
} as const;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.6;
const FIT_ZOOM = 1.3;

const layout = computed(() => buildPlanCanvas(props.nodes));
const viewport = ref<HTMLElement>();
const zoom = ref(1);
const selectedIndex = ref(-1);

const hottest = computed(() => {
  let best: PlanCanvasNode | undefined;
  for (const node of layout.value.nodes) {
    if (best === undefined || (node.costShare ?? -1) > (best.costShare ?? -1)) best = node;
  }
  return best;
});
const selected = computed(() => layout.value.nodes[selectedIndex.value] ?? hottest.value);

const edges = computed(() =>
  layout.value.edges.map((edge) => {
    const startX = edge.from.x + PLAN_CANVAS_NODE_W;
    const startY = edge.from.y + PLAN_CANVAS_NODE_H / 2;
    const endY = edge.to.y + PLAN_CANVAS_NODE_H / 2;
    const elbowX = edge.to.x - PLAN_CANVAS_GAP_X / 2;
    return {
      key: `${edge.from.node.id}->${edge.to.node.id}`,
      path: `M ${startX} ${startY} H ${elbowX} V ${endY} H ${edge.to.x}`,
      width: edgeStrokeWidth(edge.rows),
      label: formatPlanRows(edge.rows),
      labelX: edge.to.x - 8,
      labelY: endY - 8,
    };
  }),
);

interface DetailEntry {
  label?: string;
  value: string;
}

const selectedDetails = computed<DetailEntry[]>(() =>
  (selected.value?.node.details ?? [])
    .map((detail): DetailEntry => {
      const separatorIndex = detail.indexOf(":");
      if (separatorIndex === -1) return { value: detail.trim() };
      const label = detail.slice(0, separatorIndex).trim();
      return { label: label || undefined, value: detail.slice(separatorIndex + 1).trim() };
    })
    .filter((detail) => detail.label || detail.value),
);

function categoryColor(category: PlanCanvasCategory): string {
  return CATEGORY_COLORS[category];
}

function iconTint(category: PlanCanvasCategory): string {
  return `color-mix(in srgb, ${categoryColor(category)} 18%, transparent)`;
}

function costPercent(share?: number): string {
  return share === undefined ? "" : `${(share * 100).toFixed(1)}%`;
}

/** Flags a node whose measured rows are at least 2x off the estimate. */
function rowMismatch(node: PlanCanvasNode): string | undefined {
  if (node.actualRows === undefined || !node.rows) return undefined;
  const ratio = node.actualRows / node.rows;
  return ratio >= 2 || ratio <= 0.5 ? `×${ratio.toFixed(1)}` : undefined;
}

function select(index: number) {
  selectedIndex.value = index;
}

function setZoom(value: number) {
  zoom.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function zoomIn() {
  setZoom(zoom.value + 0.15);
}

function zoomOut() {
  setZoom(zoom.value - 0.15);
}

function fit() {
  const element = viewport.value;
  const { width, height } = layout.value;
  if (!element || !width || !height || !element.clientWidth || !element.clientHeight) return;
  setZoom(Math.min(element.clientWidth / width, element.clientHeight / height, FIT_ZOOM));
}

let panOrigin: { x: number; y: number; left: number; top: number } | undefined;

function stopPan() {
  panOrigin = undefined;
  window.removeEventListener("mousemove", onPanMove);
  window.removeEventListener("mouseup", stopPan);
}

function onPanMove(event: MouseEvent) {
  const element = viewport.value;
  if (!panOrigin || !element) return;
  element.scrollLeft = panOrigin.left - (event.clientX - panOrigin.x);
  element.scrollTop = panOrigin.top - (event.clientY - panOrigin.y);
}

function startPan(event: MouseEvent) {
  const element = viewport.value;
  if (!element || (event.target as HTMLElement | null)?.closest("[data-plan-node]")) return;
  panOrigin = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
  window.addEventListener("mousemove", onPanMove);
  window.addEventListener("mouseup", stopPan);
}

onBeforeUnmount(stopPan);

watch(
  () => props.nodes,
  () => {
    selectedIndex.value = -1;
    void nextTick(fit);
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <span class="flex-1" />
        <Button variant="ghost" size="xs" class="h-6 px-1.5" :aria-label="t('explain.zoomOut')" :title="t('explain.zoomOut')" @click="zoomOut">
          <ZoomOut class="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="xs" class="h-6 px-1.5" :aria-label="t('explain.zoomFit')" :title="t('explain.zoomFit')" @click="fit">
          <Maximize2 class="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="xs" class="h-6 px-1.5" :aria-label="t('explain.zoomIn')" :title="t('explain.zoomIn')" @click="zoomIn">
          <ZoomIn class="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <span class="ml-1 w-10 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{{ Math.round(zoom * 100) }}%</span>
      </div>

      <div
        ref="viewport"
        class="relative min-h-0 flex-1 cursor-grab overflow-auto active:cursor-grabbing"
        :style="{
          backgroundImage: 'linear-gradient(color-mix(in srgb, var(--border) 70%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 70%, transparent) 1px, transparent 1px)',
          backgroundSize: '28px 28px, 28px 28px',
        }"
        @mousedown="startPan"
      >
        <div :style="{ width: `${layout.width * zoom}px`, height: `${layout.height * zoom}px` }">
          <div class="relative origin-top-left" :style="{ width: `${layout.width}px`, height: `${layout.height}px`, transform: `scale(${zoom})` }">
            <svg data-plan-edges class="pointer-events-none absolute inset-0 overflow-visible text-muted-foreground/70" :width="layout.width" :height="layout.height" aria-hidden="true">
              <path v-for="edge in edges" :key="edge.key" :d="edge.path" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round" :stroke-width="edge.width" />
              <text v-for="edge in edges" :key="`${edge.key}-label`" :x="edge.labelX" :y="edge.labelY" text-anchor="end" class="fill-muted-foreground font-mono text-[10px]">{{ edge.label }}</text>
            </svg>

            <button
              v-for="(item, index) in layout.nodes"
              :key="`${item.node.id}-${index}`"
              type="button"
              data-plan-node
              :aria-pressed="selected === item"
              class="absolute flex flex-col overflow-hidden rounded-lg border bg-card py-1.5 pr-2.5 pl-3 text-left transition-shadow hover:shadow-md"
              :class="selected === item ? 'border-ring ring-2 ring-ring/30' : ''"
              :style="{ left: `${item.x}px`, top: `${item.y}px`, width: `${PLAN_CANVAS_NODE_W}px`, height: `${PLAN_CANVAS_NODE_H}px` }"
              @click="select(index)"
            >
              <span class="absolute inset-y-0 left-0 w-[3px] rounded-l-lg" :style="{ background: HEAT_COLORS[heatLevel(item.costShare)] }" aria-hidden="true" />

              <span class="flex min-w-0 items-center gap-1.5">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded" :style="{ background: iconTint(item.category), color: categoryColor(item.category) }">
                  <component :is="CATEGORY_ICONS[item.category]" class="h-3 w-3" aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1 truncate text-xs font-semibold">{{ item.node.nodeType || item.node.title }}</span>
                <span v-if="item.costShare !== undefined" class="shrink-0 rounded px-1 font-mono text-[10px] font-semibold tabular-nums" :class="HEAT_BADGE_CLASSES[heatLevel(item.costShare)]">
                  {{ costPercent(item.costShare) }}
                </span>
              </span>

              <span class="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                {{ item.node.relation || " " }}
                <span v-if="item.node.index" :style="{ color: CATEGORY_COLORS.iscan }">[{{ item.node.index }}]</span>
              </span>

              <span class="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                <span class="truncate">{{ t("explain.estRows") }} {{ formatPlanRows(item.rows) }}</span>
                <span v-if="rowMismatch(item)" class="ml-auto shrink-0 font-semibold text-amber-600 dark:text-amber-400">{{ rowMismatch(item) }}</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1 text-[11px] text-muted-foreground">
        <span>{{ t("explain.legendHeat") }}</span>
        <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-[2px]" :style="{ background: HEAT_COLORS.cool }" />&lt; 5%</span>
        <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-[2px]" :style="{ background: HEAT_COLORS.warm }" />5–20%</span>
        <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-[2px]" :style="{ background: HEAT_COLORS.hot }" />&gt; 20%</span>
        <span class="ml-2">{{ t("explain.legendEdge") }}</span>
      </div>
    </div>

    <aside class="hidden w-72 shrink-0 flex-col overflow-auto border-l md:flex">
      <template v-if="selected">
        <div class="border-b p-3">
          <div class="flex items-center gap-2">
            <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded" :style="{ background: iconTint(selected.category), color: categoryColor(selected.category) }">
              <component :is="CATEGORY_ICONS[selected.category]" class="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div class="min-w-0">
              <div class="truncate text-sm font-semibold">{{ selected.node.nodeType || selected.node.title }}</div>
              <div class="text-[11px] font-medium" :style="{ color: categoryColor(selected.category) }">{{ t(CATEGORY_LABEL_KEYS[selected.category]) }}</div>
            </div>
          </div>
          <div v-if="selected.node.relation || selected.node.index" class="mt-2 truncate font-mono text-[11px] text-muted-foreground">
            {{ selected.node.relation }}<template v-if="selected.node.index"> [{{ selected.node.index }}]</template>
          </div>
        </div>

        <div class="grid grid-cols-2 border-b text-xs">
          <div class="border-r border-b p-2">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ t("explain.costShare") }}</div>
            <div class="font-mono font-semibold tabular-nums" :style="{ color: HEAT_COLORS[heatLevel(selected.costShare)] }">{{ costPercent(selected.costShare) || "—" }}</div>
          </div>
          <div class="border-b p-2">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ t("explain.cost") }}</div>
            <div class="truncate font-mono font-semibold tabular-nums">{{ selected.node.cost || "—" }}</div>
          </div>
          <div class="border-r p-2">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ t("explain.estRows") }}</div>
            <div class="font-mono font-semibold tabular-nums">{{ formatPlanRows(selected.rows) }}</div>
          </div>
          <div class="p-2">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ t("explain.actualRows") }}</div>
            <div class="font-mono font-semibold tabular-nums" :class="rowMismatch(selected) ? 'text-amber-600 dark:text-amber-400' : ''">{{ formatPlanRows(selected.actualRows) }}</div>
          </div>
        </div>

        <div v-if="selectedDetails.length" class="min-h-0 flex-1 overflow-auto p-3">
          <div class="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">{{ t("explain.details") }}</div>
          <div v-for="(detail, index) in selectedDetails" :key="index" class="space-y-1 border-b py-2 first:pt-0 last:border-b-0 last:pb-0">
            <div v-if="detail.label" class="text-[11px] font-medium">{{ detail.label }}</div>
            <div class="select-text whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">{{ detail.value }}</div>
          </div>
        </div>
      </template>

      <div v-else class="flex flex-1 items-center justify-center p-3 text-xs text-muted-foreground">{{ t("explain.inspectorEmpty") }}</div>
    </aside>
  </div>
</template>
