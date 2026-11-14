/**
 * Option builder for `scatter`.
 *
 * Both axes are `value` axes (a scatter is numeric x vs numeric y), so there is
 * no category data to align. Points are emitted as item objects so `name` (when
 * the model supplied one) reaches the tooltip and `size` reaches `symbolSize`.
 */

import type { EChartsOption } from "echarts";
import { axisLabelColor, chartTitleOption, legendTextStyle } from "@/lib/ai/richContent/aiChartOptions/theme";
import type { AiChartTheme, ScatterAiChartSpec } from "@/lib/ai/richContent/aiChartShared";

export function buildScatterOption(spec: ScatterAiChartSpec, theme: AiChartTheme): EChartsOption {
  return {
    aria: { enabled: true },
    tooltip: { trigger: "item" },
    legend: { bottom: 0, textStyle: legendTextStyle(theme) },
    title: chartTitleOption(spec.title, theme),
    grid: { left: 60, right: 20, top: spec.title ? 40 : 20, bottom: 40 },
    xAxis: {
      type: "value",
      name: spec.xAxis?.label ?? undefined,
      nameTextStyle: { color: axisLabelColor(theme) },
      axisLabel: { color: axisLabelColor(theme) },
      scale: true,
    },
    yAxis: {
      type: "value",
      name: spec.yAxis?.label ?? undefined,
      nameTextStyle: { color: axisLabelColor(theme) },
      axisLabel: { color: axisLabelColor(theme) },
      scale: true,
    },
    series: spec.series.map((series) => ({
      name: series.name,
      type: "scatter",
      // `scale: true` above keeps the axes off zero, which matters for clusters
      // far from the origin (e.g. latency vs timestamp). Item objects carry the
      // optional name/size through without per-series configuration.
      data: series.data.map((point) => {
        const value: [number, number] | [number, number, number] = point.size === undefined ? [point.x, point.y] : [point.x, point.y, point.size];
        const item: { value: typeof value; name?: string; symbolSize?: number } = { value };
        if (point.name !== undefined) item.name = point.name;
        if (point.size !== undefined) item.symbolSize = point.size;
        return item;
      }),
      // A bubble chart needs a readable base size; without an explicit value the
      // default applies, and only sized points are scaled up.
      symbolSize: 10,
    })),
  };
}
