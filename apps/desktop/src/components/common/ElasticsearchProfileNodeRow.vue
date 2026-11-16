<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronRight, ChevronDown } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { formatProfileNanos } from "@/lib/elasticsearch/elasticsearchProfile";
import type { ElasticsearchProfileNode, ElasticsearchProfileHeatLevel } from "@/lib/elasticsearch/elasticsearchProfile";

const HEAT_COLORS: Record<ElasticsearchProfileHeatLevel, string> = {
  none: "var(--muted-foreground)",
  cool: "#22c55e",
  warm: "#f59e0b",
  hot: "#ef4444",
};

const HEAT_BADGE_CLASSES: Record<ElasticsearchProfileHeatLevel, string> = {
  none: "bg-muted text-muted-foreground",
  cool: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  warm: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  hot: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

/** Nodes at or below this depth start collapsed to keep large trees responsive. */
const COLLAPSE_DEFAULT_DEPTH = 4;

const props = withDefaults(
  defineProps<{
    node: ElasticsearchProfileNode;
    depth?: number;
    /** null = manual per-node state; "expanded"/"collapsed" = a global override. */
    globalCollapse?: "expanded" | "collapsed" | null;
  }>(),
  { depth: 0, globalCollapse: null },
);

const emit = defineEmits<{
  /** The user toggled a node while a global expand/collapse was active. */
  manual: [];
}>();

const { t } = useI18n();
const hasChildren = computed(() => props.node.children.length > 0);
const localCollapsed = ref((props.depth ?? 0) >= COLLAPSE_DEFAULT_DEPTH);
const collapsed = computed(() => {
  if (props.globalCollapse === "collapsed") return true;
  if (props.globalCollapse === "expanded") return false;
  return localCollapsed.value;
});

function toggle() {
  if (props.globalCollapse !== null) {
    localCollapsed.value = !collapsed.value;
    emit("manual");
  } else {
    localCollapsed.value = !localCollapsed.value;
  }
}

const breakdownEntries = computed(() =>
  Object.entries(props.node.breakdown ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value })),
);
const barPercent = computed(() => `${Math.min(100, props.node.costShare * 100)}%`);
const costPercent = computed(() => {
  const percent = props.node.costShare * 100;
  return percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
});
</script>

<template>
  <div>
    <div class="flex min-w-0 items-center gap-1 rounded border bg-background px-2 py-1 text-xs" :class="node.isCriticalPath ? 'border-orange-500/40 bg-orange-500/[0.04]' : 'border-border'">
      <Button v-if="hasChildren" variant="ghost" size="icon-xs" class="-ml-1 h-5 w-5 shrink-0 text-foreground/80" :aria-label="node.type" :aria-expanded="!collapsed" @click="toggle">
        <ChevronRight v-if="collapsed" class="h-3 w-3" aria-hidden="true" />
        <ChevronDown v-else class="h-3 w-3" aria-hidden="true" />
      </Button>
      <span v-else class="h-5 w-5 shrink-0" aria-hidden="true" />

      <span class="shrink-0 rounded bg-muted px-1 py-0.5 font-mono font-medium">{{ node.type }}</span>
      <span v-if="node.description" class="min-w-0 flex-1 truncate text-foreground/70" :title="node.description">{{ node.description }}</span>
      <span v-if="!node.description && !hasChildren" class="min-w-0 flex-1" aria-hidden="true" />

      <span class="shrink-0 tabular-nums text-foreground/80" :title="t('profile.selfTime')">self {{ formatProfileNanos(node.selfTimeInNanos) }}</span>
      <span class="shrink-0 tabular-nums text-muted-foreground" :title="t('profile.totalTime')">total {{ formatProfileNanos(node.timeInNanos) }}</span>

      <div class="flex w-24 shrink-0 items-center gap-1">
        <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <div class="h-full rounded-full" :style="{ width: barPercent, background: HEAT_COLORS[node.heatLevel] }" />
        </div>
        <span class="shrink-0 rounded px-1 font-mono text-[10px] font-semibold tabular-nums" :class="HEAT_BADGE_CLASSES[node.heatLevel]" :title="t('profile.legendSelfTime')">{{ costPercent }}</span>
      </div>

      <span v-if="node.isCriticalPath" class="shrink-0 rounded border border-orange-500/30 bg-orange-500/10 px-1 py-0.5 text-[10px] font-semibold text-orange-700 dark:text-orange-300" :title="t('profile.criticalPath')">
        {{ t("profile.criticalPathTag") }}
      </span>
    </div>

    <div v-if="!collapsed">
      <div v-if="breakdownEntries.length" class="ml-6 mt-px flex flex-wrap items-center gap-1 pl-2">
        <span class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ t("profile.breakdown") }}</span>
        <span v-for="entry in breakdownEntries" :key="entry.name" class="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px] tabular-nums text-foreground/80">{{ entry.name }}:{{ formatProfileNanos(entry.value) }}</span>
      </div>
      <div v-if="node.children.length" class="ml-3 mt-px space-y-px border-l pl-2">
        <ElasticsearchProfileNodeRow v-for="(child, index) in node.children" :key="index" :node="child" :depth="depth + 1" :global-collapse="globalCollapse" @manual="emit('manual')" />
      </div>
    </div>
  </div>
</template>
