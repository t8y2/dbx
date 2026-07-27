<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronRight, ChevronDown, Info } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ExplainPlanNode } from "@/lib/diagram/explainPlan";

const props = defineProps<{
  node: ExplainPlanNode;
}>();

const { t } = useI18n();
const collapsed = ref(false);
const hasChildren = computed(() => props.node.children.length > 0);

interface ExplainPlanDetailEntry {
  label?: string;
  value: string;
}

const detailEntries = computed<ExplainPlanDetailEntry[]>(() =>
  props.node.details
    .map((detail): ExplainPlanDetailEntry => {
      const separatorIndex = detail.indexOf(":");
      if (separatorIndex === -1) return { value: detail.trim() };

      const label = detail.slice(0, separatorIndex).trim();
      return {
        label: label || undefined,
        value: detail.slice(separatorIndex + 1).trim(),
      };
    })
    .filter((detail) => detail.label || detail.value),
);

const detailPreviewEntries = computed(() => detailEntries.value.filter((detail) => detail.label !== "Actual Rows").slice(0, 2));

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
}

const actualRows = computed(() => {
  for (const detail of props.node.details) {
    const match = detail.match(/Actual Rows:\s*(\S+)/);
    if (match) return match[1];
  }
  return undefined;
});

const hasActualStats = computed(() => !!actualRows.value);
const rowDiffers = computed(() => hasActualStats.value && actualRows.value !== props.node.rows);
</script>

<template>
  <div>
    <div class="flex min-w-0 items-center gap-1 rounded border bg-background px-2 py-1 text-xs">
      <Button v-if="hasChildren" variant="ghost" size="icon-xs" class="-ml-1 h-5 w-5 shrink-0 text-foreground/80" :aria-label="node.title" :aria-expanded="!collapsed" @click="toggleCollapsed">
        <ChevronRight v-if="collapsed" class="h-3 w-3" aria-hidden="true" />
        <ChevronDown v-else class="h-3 w-3" aria-hidden="true" />
      </Button>
      <span v-else class="h-5 w-5 shrink-0" aria-hidden="true" />

      <span class="shrink-0 rounded bg-muted px-1 py-0.5 font-medium">{{ node.nodeType }}</span>
      <span v-if="node.relation" class="shrink-0 truncate max-w-[120px] text-foreground">{{ node.relation }}</span>
      <span v-if="node.index" class="shrink-0 font-medium text-foreground/80">[{{ node.index }}]</span>
      <span v-if="node.cost" class="shrink-0 tabular-nums text-foreground/80">c:{{ node.cost }}</span>
      <span v-if="node.rows" class="shrink-0 tabular-nums text-foreground/80">e:{{ node.rows }}</span>
      <span v-if="hasActualStats" class="shrink-0 tabular-nums font-semibold text-foreground"
        >a:{{ actualRows }}<span v-if="rowDiffers">({{ Math.round((Number(actualRows) / Number(node.rows)) * 100) }}%)</span></span
      >

      <div v-if="detailPreviewEntries.length" class="ml-1 flex min-w-0 flex-1 items-center gap-2 text-foreground/80">
        <span v-for="(detail, index) in detailPreviewEntries" :key="index" class="min-w-0 flex-1 truncate">
          <span v-if="detail.label" class="font-medium text-foreground">{{ detail.label }}:</span>
          {{ detail.value }}
        </span>
      </div>

      <Popover v-if="detailEntries.length">
        <PopoverTrigger as-child>
          <Button variant="outline" size="xs" class="ml-auto h-5 shrink-0 gap-1 px-1.5 text-[11px] font-normal text-foreground/80" :aria-label="t('explain.details')">
            <Info class="h-3 w-3" aria-hidden="true" />
            {{ t("explain.details") }}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-[min(32rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0" @click.stop>
          <div data-native-clipboard class="max-h-[min(24rem,calc(100vh-8rem))] overflow-auto p-3">
            <div v-for="(detail, index) in detailEntries" :key="index" class="space-y-1 border-b py-2 first:pt-0 last:border-b-0 last:pb-0">
              <div v-if="detail.label" class="text-[11px] font-medium text-popover-foreground">
                {{ detail.label }}
              </div>
              <div class="select-text whitespace-pre-wrap break-words text-xs leading-5">
                {{ detail.value }}
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>

    <!-- Children (collapsible) -->
    <div v-if="node.children.length && !collapsed" class="ml-3 mt-px space-y-px border-l pl-2">
      <ExplainPlanNodeTree v-for="child in node.children" :key="child.id" :node="child" />
    </div>
  </div>
</template>
