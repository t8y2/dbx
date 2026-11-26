<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LineChart, BarChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";
import VChart from "vue-echarts";
import { BarChart3, Check, ChevronDown, Settings2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { QueryResult } from "@/types/database";
import { useTheme } from "@/composables/useTheme";
import { axisColumnLabel, chartableColumnIndexes, buildQueryChartOption, type ChartType, type XAxisType, type YAxisType } from "@/lib/dataGrid/chartData";

use([CanvasRenderer, LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent]);

const props = defineProps<{
  result: QueryResult;
}>();

const { t } = useI18n();
const { isDark } = useTheme();

const QUERY_CHART_SHOW_LABELS_KEY = "dbx-query-chart-show-labels";

function readShowLabelsPreference(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(QUERY_CHART_SHOW_LABELS_KEY) === "true";
  } catch {
    return false;
  }
}

const chartType = ref<ChartType>("bar");
// Keep data shapes explicit: no silent auto-detection. The user picks the
// axis that matches what the data actually means.
const xAxisType = ref<XAxisType>("category");
const yAxisType = ref<YAxisType>("value");
const smoothOverride = ref<boolean | null>(null);
const settingsOpen = ref(false);
const xColumnIndex = ref(0);
const yColumnIndexes = ref<number[]>([]);
const showLabels = ref(readShowLabelsPreference());

watch(showLabels, (val) => {
  try {
    localStorage.setItem(QUERY_CHART_SHOW_LABELS_KEY, String(val));
  } catch {
    // ignore
  }
});

const numericColumnIndexes = computed(() => chartableColumnIndexes(props.result));

const allColumnOptions = computed(() => props.result.columns.map((_, index) => ({ index, label: axisColumnLabel(props.result.columns, index) })));
const numericColumnOptions = computed(() => numericColumnIndexes.value.map((index) => ({ index, label: axisColumnLabel(props.result.columns, index) })));
const xColumnValue = computed({
  get: () => String(xColumnIndex.value),
  set: (value: string) => {
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0 && index < props.result.columns.length) {
      xColumnIndex.value = index;
    }
  },
});
const xAxisTypeValue = computed({
  get: () => xAxisType.value,
  set: (value: string) => {
    if (value === "auto" || value === "category" || value === "time") xAxisType.value = value;
  },
});
const xAxisTypeOptions: { value: XAxisType; labelKey: string }[] = [
  { value: "auto", labelKey: "chart.xAxisAuto" },
  { value: "category", labelKey: "chart.xAxisCategory" },
  { value: "time", labelKey: "chart.xAxisTime" },
];
const yAxisTypeValue = computed({
  get: () => yAxisType.value,
  set: (value: string) => {
    if (value === "value" || value === "log") yAxisType.value = value;
  },
});
const yAxisTypeOptions: { value: YAxisType; labelKey: string }[] = [
  { value: "value", labelKey: "chart.yAxisValue" },
  { value: "log", labelKey: "chart.yAxisLog" },
];
// null = let buildQueryChartOption decide (straight on time axes, smooth on category axes).
// Once the user flips the switch it becomes an explicit choice.
const effectiveSmooth = computed(() => smoothOverride.value ?? (chartType.value === "line" && xAxisType.value !== "time"));
const smoothValue = computed({
  get: () => effectiveSmooth.value,
  set: (value: boolean) => {
    smoothOverride.value = value;
  },
});
const yColumnLabel = computed(() => {
  if (yColumnIndexes.value.length === 0) return "0";
  const [first, ...rest] = yColumnIndexes.value;
  const label = axisColumnLabel(props.result.columns, first);
  return rest.length > 0 ? `${label} +${rest.length}` : label;
});

watch(
  () => props.result,
  () => {
    const cols = props.result.columns;
    const numCols = numericColumnIndexes.value;
    xColumnIndex.value = cols.findIndex((_, index) => !numCols.includes(index));
    if (xColumnIndex.value < 0) xColumnIndex.value = cols.length > 0 ? 0 : -1;
    yColumnIndexes.value = numCols.length > 0 ? [numCols[0]] : [];
  },
  { immediate: true },
);

function toggleYColumn(index: number) {
  const isSelected = yColumnIndexes.value.includes(index);
  if (isSelected) {
    yColumnIndexes.value = yColumnIndexes.value.filter((selected) => selected !== index);
  } else {
    yColumnIndexes.value = [...yColumnIndexes.value, index];
  }
}

const chartOption = computed(() => {
  return buildQueryChartOption(props.result, {
    chartType: chartType.value,
    xColumnIndex: xColumnIndex.value,
    yColumnIndexes: yColumnIndexes.value,
    showLabels: showLabels.value,
    isDark: isDark.value,
    xAxisType: xAxisType.value,
    yAxisType: yAxisType.value,
    smooth: smoothOverride.value ?? undefined,
  });
});

const hasData = computed(() => props.result.rows.length > 0 && numericColumnIndexes.value.length > 0);
</script>

<template>
  <div class="h-full flex flex-col">
    <div v-if="!hasData" class="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
      <BarChart3 class="h-10 w-10 opacity-30" />
      <span>{{ t("chart.noNumericData") }}</span>
    </div>
    <template v-else>
      <div class="h-9 shrink-0 border-b bg-muted/20 px-3 flex items-center gap-3 text-xs">
        <div class="flex items-center gap-1.5">
          <span class="text-muted-foreground">{{ t("chart.type") }}</span>
          <div class="flex gap-0.5">
            <Button v-for="ct in ['bar', 'line', 'pie'] as ChartType[]" :key="ct" size="sm" :variant="chartType === ct ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs" @click="chartType = ct">
              {{ t(`chart.${ct}`) }}
            </Button>
          </div>
        </div>
        <span class="h-4 w-px bg-border" />
        <div class="flex items-center gap-1.5">
          <span class="text-muted-foreground">X</span>
          <Select v-model="xColumnValue">
            <SelectTrigger class="h-6 w-auto max-w-40 border-0 bg-transparent px-1 text-xs shadow-none focus:ring-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="col in allColumnOptions" :key="col.index" :value="String(col.index)">{{ col.label }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <span class="h-4 w-px bg-border" />
        <div class="flex items-center gap-1.5">
          <span class="text-muted-foreground">Y</span>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="sm" class="h-6 max-w-48 gap-1 px-2 text-xs">
                <span class="truncate">{{ yColumnLabel }}</span>
                <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="w-56" align="start" @close-auto-focus.prevent>
              <DropdownMenuItem
                v-for="col in numericColumnOptions"
                :key="col.index"
                role="menuitemcheckbox"
                :aria-checked="yColumnIndexes.includes(col.index)"
                class="text-xs flex items-center gap-2 cursor-pointer"
                :class="yColumnIndexes.includes(col.index) ? 'bg-primary/10' : ''"
                @select.prevent="toggleYColumn(col.index)"
              >
                <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border" :class="yColumnIndexes.includes(col.index) ? 'border-primary bg-primary text-primary-foreground' : 'border-input'">
                  <Check v-if="yColumnIndexes.includes(col.index)" class="h-2.5 w-2.5" />
                </span>
                <span class="truncate">{{ col.label }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div class="ml-auto">
          <Button size="sm" variant="ghost" class="h-6 gap-1 px-2 text-xs" data-testid="query-chart-settings-btn" @click="settingsOpen = true">
            <Settings2 class="h-3.5 w-3.5" />
            {{ t("chart.settings") }}
          </Button>
        </div>
      </div>
      <div class="flex-1 min-h-0 p-2">
        <VChart v-if="chartOption" :option="chartOption" autoresize class="h-full w-full" />
      </div>
    </template>

    <Dialog v-model:open="settingsOpen">
      <DialogContent class="sm:max-w-md" data-testid="query-chart-settings-dialog">
        <DialogHeader>
          <DialogTitle>{{ t("chart.settings") }}</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-4 py-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-muted-foreground">{{ t("chart.xAxisType") }}</span>
            <Select v-model="xAxisTypeValue">
              <SelectTrigger class="h-8 w-32" data-testid="query-chart-x-axis-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="mode in xAxisTypeOptions" :key="mode.value" :value="mode.value">{{ t(mode.labelKey) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-muted-foreground">{{ t("chart.yAxisType") }}</span>
            <Select v-model="yAxisTypeValue">
              <SelectTrigger class="h-8 w-32" data-testid="query-chart-y-axis-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="mode in yAxisTypeOptions" :key="mode.value" :value="mode.value">{{ t(mode.labelKey) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-muted-foreground">{{ t("chart.smooth") }}</span>
            <Switch v-model="smoothValue" data-testid="query-chart-smooth" />
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-muted-foreground">{{ t("chart.showLabels") }}</span>
            <Switch v-model="showLabels" data-testid="query-chart-show-labels" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
