/**
 * Option builder for `heatmap`.
 *
 * Two things here are load-bearing and must not be "simplified":
 *
 * 1. BOTH axes are `category` with `boundaryGap: true`. echarts 6.1.0 silently
 *    renders garbage otherwise, because the two guards that reject the wrong
 *    axis configuration are `NODE_ENV !== 'production'` only
 *    (HeatmapView.js:155 / :158).
 * 2. A `visualMap` must be present — without one the view throws
 *    "Heatmap must use with visualMap" at render time.
 *
 * `visualMap.min` / `max` are derived from the data because ECharts defaults to
 * 0 / 200, which paints every cell saturated (or washed out) for real datasets.
 *
 * The visualMap sits in a band BELOW the x-axis labels. ECharts positions the
 * component from `bottom` and draws its value labels along the bar, so the
 * default (a 90px bar starting 8px from the bottom edge) puts "min"/"max" on the
 * same row as the category labels and they overlap — with an axis `name` the
 * collision appears even on a 480px-wide canvas. `grid.bottom` reserves the
 * whole band (bar + its labels) so the two never share a row.
 */

import type { EChartsOption } from "echarts";
import { axisLabelColor, chartTitleOption } from "@/lib/ai/richContent/aiChartOptions/theme";
import type { AiChartTheme, HeatmapAiChartSpec } from "@/lib/ai/richContent/aiChartShared";

/** Low → high ramp; dark mode starts from the card background so low cells recede. */
function colorRamp(theme: AiChartTheme): [string, string] {
  return theme.isDark ? ["#1e293b", "#38bdf8"] : ["#eff6ff", "#1d4ed8"];
}

export function buildHeatmapOption(spec: HeatmapAiChartSpec, theme: AiChartTheme): EChartsOption {
  // Categories are matched through the same string projection the parser used,
  // so `1` in `data.x` finds the axis category `"1"`.
  const xIndex = new Map(spec.xAxis.values.map((value, position) => [String(value), position]));
  const yIndex = new Map(spec.yAxis.values.map((value, position) => [String(value), position]));

  const cells = spec.data.map((entry) => [xIndex.get(String(entry.x)) ?? 0, yIndex.get(String(entry.y)) ?? 0, entry.value]);

  const values = spec.data.map((entry) => entry.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat dataset has min === max, which collapses the colour scale. Widen it
  // symmetrically instead of appending a single step above: `[v, v + 1]` would
  // paint the only value at the very bottom of the ramp (near-white for a
  // light-mode low colour), while `[v - 0.5, v + 0.5]` puts it in the middle and
  // keeps the legend meaningful. Verified against echarts 6.1.0: the single cell
  // renders the mid-ramp colour.
  const lower = max > min ? min : min - 0.5;
  const upper = max > min ? max : max + 0.5;

  return {
    aria: { enabled: true },
    tooltip: { trigger: "item" },
    title: chartTitleOption(spec.title, theme),
    // The band below the plot holds the x-axis labels AND the visualMap bar with
    // its min/max labels (measured: axis row at height-70, visualMap labels at
    // height-52). A 70px band put them on the same row — with an axis `name` the
    // text overlapped even on a 480px canvas — so the plot stops 84px up.
    grid: { left: 70, right: 20, top: spec.title ? 40 : 20, bottom: 84 },
    xAxis: {
      type: "category",
      name: spec.xAxis.label ?? undefined,
      nameTextStyle: { color: axisLabelColor(theme) },
      data: spec.xAxis.values,
      // Required by the cartesian heatmap layout.
      boundaryGap: true,
      splitArea: { show: false },
      axisLabel: { color: axisLabelColor(theme) },
    },
    yAxis: {
      type: "category",
      name: spec.yAxis.label ?? undefined,
      nameTextStyle: { color: axisLabelColor(theme) },
      data: spec.yAxis.values,
      boundaryGap: true,
      splitArea: { show: false },
      axisLabel: { color: axisLabelColor(theme) },
    },
    visualMap: {
      min: lower,
      max: upper,
      calculable: true,
      orient: "horizontal",
      left: "center",
      // Anchored to the canvas bottom so the bar sits BELOW the x-axis labels
      // rather than on top of them (see the grid comment above).
      bottom: 0,
      itemHeight: 90,
      textStyle: { color: axisLabelColor(theme) },
      inRange: { color: colorRamp(theme) },
    },
    series: [
      {
        type: "heatmap",
        data: cells,
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,0.3)" } },
      },
    ],
  };
}
