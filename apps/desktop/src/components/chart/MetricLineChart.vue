<script setup lang="ts">
import { computed } from "vue";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";
import VChart from "vue-echarts";
import { useTheme } from "@/composables/useTheme";

// Reuses the piecewise ECharts registration pattern from QueryChart.vue, but a
// dedicated time-series line chart for live metrics (no bar/pie, no result prop).
use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent]);

interface Series {
  name: string;
  data: number[];
  color?: string;
}

const props = defineProps<{
  title: string;
  labels: string[];
  series: Series[];
  height?: number;
  valueFormatter?: (value: number) => string;
}>();

const { isDark } = useTheme();

const axisColor = computed(() => (isDark.value ? "#3f3f46" : "#e4e4e7"));
const textColor = computed(() => (isDark.value ? "#a1a1aa" : "#71717a"));

const chartOption = computed(() => {
  const format = props.valueFormatter ?? ((v: number) => String(Math.round(v)));
  return {
    animation: false,
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    legend: props.series.length > 1 ? { top: 0, textStyle: { color: textColor.value, fontSize: 11 }, itemHeight: 8, itemWidth: 12 } : undefined,
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: number) => format(value),
    },
    xAxis: {
      type: "category",
      data: props.labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: axisColor.value } },
      axisLabel: { color: textColor.value, fontSize: 10 },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: textColor.value, fontSize: 10, formatter: (value: number) => format(value) },
      splitLine: { lineStyle: { color: axisColor.value } },
    },
    series: props.series.map((s) => ({
      name: s.name,
      type: "line",
      data: s.data,
      smooth: true,
      showSymbol: false,
      lineStyle: s.color ? { color: s.color, width: 2 } : { width: 2 },
      itemStyle: s.color ? { color: s.color } : undefined,
      areaStyle: props.series.length === 1 ? { opacity: 0.12 } : undefined,
    })),
  };
});
</script>

<template>
  <div class="flex flex-col rounded-lg border bg-card p-3">
    <div class="mb-1 text-xs font-medium text-muted-foreground">{{ title }}</div>
    <VChart :option="chartOption" autoresize :style="{ height: `${height ?? 160}px` }" />
  </div>
</template>
