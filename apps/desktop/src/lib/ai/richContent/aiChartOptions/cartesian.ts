/**
 * Option builder for the cartesian family: `line`, `bar`, `pictorialBar`.
 *
 * The dense-category layout rules (dataZoom band at the canvas bottom, legend
 * lifted above it, rotated truncated labels) are shared by all three, so they
 * stay in one place rather than being copied per type.
 */

import type { EChartsOption } from "echarts";
import { axisLabelColor, chartTitleOption, legendTextStyle } from "@/lib/ai/richContent/aiChartOptions/theme";
import type { AiChartMark, AiChartTheme, LineBarAiChartSpec, PictorialBarAiChartSpec } from "@/lib/ai/richContent/aiChartShared";

/** Category count above which the axis gets a scrollable dataZoom band. */
const DENSE_CATEGORY_THRESHOLD = 12;

export function buildCartesianOption(spec: LineBarAiChartSpec | PictorialBarAiChartSpec, theme: AiChartTheme): EChartsOption {
  const denseCategories = spec.xAxis.values.length > DENSE_CATEGORY_THRESHOLD;
  const pictorial = spec.type === "pictorialBar";
  const marksName = spec.marks !== undefined ? marksSeriesName(spec.series.map((series) => series.name)) : undefined;

  // The slider dataZoom band owns the canvas bottom edge (bottom: 0). The legend
  // must sit ABOVE that band — an unplaced legend (bottom: 0) would overlap the
  // slider and make both unreadable on dense axes.
  return {
    aria: { enabled: true },
    tooltip: { trigger: "axis" },
    legend: {
      ...(denseCategories ? { bottom: 32 } : { bottom: 0 }),
      textStyle: legendTextStyle(theme),
      // Listing the business series explicitly keeps the internal marks series
      // out of the legend (an unlisted series gets no entry and no toggle).
      // Omitted without marks so the no-marks option stays as it was.
      ...(marksName !== undefined ? { data: spec.series.map((series) => series.name) } : {}),
    },
    title: chartTitleOption(spec.title, theme),
    // A reference line is labelled at the grid's top edge. When a title already
    // occupies that row the label lands on top of it (measured at 480px: title
    // y=27, label y=29, overlapping x spans), so the plot starts one label-height
    // lower whenever marks exist. Without marks the geometry is unchanged.
    grid: {
      left: 60,
      right: 20,
      top: spec.title ? (spec.marks !== undefined ? 52 : 40) : 20,
      bottom: denseCategories ? 76 : 40,
    },
    dataZoom: denseCategories ? [{ type: "inside" }, { type: "slider", bottom: 0, height: 16 }] : undefined,
    xAxis: {
      type: "category",
      name: spec.xAxis.label ?? undefined,
      nameTextStyle: { color: axisLabelColor(theme) },
      data: spec.xAxis.values,
      axisLabel: denseCategories ? { color: axisLabelColor(theme), rotate: 35, overflow: "truncate", width: 88 } : { color: axisLabelColor(theme) },
    },
    yAxis: {
      type: "value",
      name: spec.yAxis?.label ?? undefined,
      nameTextStyle: { color: axisLabelColor(theme) },
      axisLabel: { color: axisLabelColor(theme) },
      // A reference line outside the data extent is silently dropped by ECharts
      // (its markLine filter discards lines whose value is outside the axis
      // range — verified against echarts 6.1.0), so a `marks` value above the
      // series max or below its min would never be drawn. Extending the axis by
      // the marks keeps them visible. `min`/`max` callbacks are only used when
      // marks exist so the no-marks option is byte-identical to before.
      ...(spec.marks !== undefined ? valueAxisExtentForMarks(spec.marks) : {}),
    },
    series: [
      ...spec.series.map((series) => {
        const base: Record<string, unknown> = {
          name: series.name,
          type: spec.type,
          data: series.data,
        };
        if (pictorial) {
          base.symbol = (spec as PictorialBarAiChartSpec).symbol ?? "circle";
        } else {
          const cartesian = spec as LineBarAiChartSpec;
          if (cartesian.step !== undefined) {
            base.step = cartesian.step;
            // Step and smooth cancel each other out: ECharts first converts the
            // line into stair geometry and only then applies the smooth Bezier
            // over those points (LineView renders step, then sets shape.smooth),
            // which rounds every right-angle corner away. A step line must stay
            // piecewise-linear, so smooth is forced off.
            base.smooth = false;
          } else {
            // Smooth only matters for line; a bar has nothing to smooth.
            base.smooth = spec.type === "line";
          }
          if (cartesian.area) base.areaStyle = {};
        }
        if (spec.stack !== undefined) base.stack = spec.stack;
        return base;
      }),
      ...(marksName !== undefined && spec.marks !== undefined ? [marksSeries(marksName, spec.marks)] : []),
    ],
  } as EChartsOption;
}

/**
 * A chart-unique name for the marks series that no business series can collide
 * with (a shared name would make a legend toggle hide both).
 */
function marksSeriesName(taken: readonly string[]): string {
  const names = new Set(taken);
  let name = "__marks__";
  while (names.has(name)) name += "_";
  return name;
}

/**
 * Reference lines live on their own legend-excluded series.
 *
 * Attaching them to the first business series ties their lifetime to that
 * series: hiding it from the legend hides its markLine too (verified against
 * echarts 6.1.0 — `legendToggleSelect` on the owner removes the line AND its
 * label), even though the reference line belongs to the whole chart. A series
 * with no data draws nothing but its markLine, `silent` keeps it out of
 * tooltips/hover, and `legend.data` (business names only) keeps it out of the
 * legend.
 */
function marksSeries(name: string, marks: AiChartMark[]): Record<string, unknown> {
  return {
    name,
    type: "line",
    data: [],
    silent: true,
    animation: false,
    tooltip: { show: false },
    markLine: {
      data: marks.map(markLineEntry),
      // ECharts' markLine label defaults to the raw y value, which makes a
      // named threshold ("target") indistinguishable from the axis tick. Show
      // the name alongside the value when the model supplied one.
      label: { show: true, position: "insideEndTop", formatter: markLineLabel },
    },
  };
}

/**
 * ECharts 6 markLine accepts `{ name, yAxis }` for a horizontal line — NOT
 * `{ name, value }`, which logs "Invalid markLine data." and then throws
 * (verified against echarts 6.1.0 in dev AND production).
 */
function markLineEntry(mark: AiChartMark): { name?: string; yAxis: number } {
  return mark.name === undefined ? { yAxis: mark.value } : { name: mark.name, yAxis: mark.value };
}

/**
 * Widen the value axis so every reference line stays inside it.
 *
 * ECharts' markLine filter silently drops a line whose value is outside the axis
 * range, so a mark above the series max or below its min would never be drawn
 * (verified against echarts 6.1.0). Supplying `min`/`max` callbacks bypasses the
 * default zero-inclusion for a `value` axis (`scale` is false by default), so
 * zero is re-added explicitly and the no-marks axis shape is preserved exactly.
 */
function valueAxisExtentForMarks(marks: AiChartMark[]): { min: (extent: { min: number; max: number }) => number; max: (extent: { min: number; max: number }) => number } {
  const values = marks.map((mark) => mark.value);
  const lowestMark = Math.min(...values);
  const highestMark = Math.max(...values);
  return {
    min: (extent) => Math.min(extent.min, lowestMark, 0),
    max: (extent) => Math.max(extent.max, highestMark, 0),
  };
}

/**
 * ECharts' default markLine label renders the y value only. A named reference
 * line should read "target 180" rather than an unlabelled "180" that looks like
 * an axis tick.
 */
function markLineLabel(params: { name?: string; value?: unknown }): string {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  return name ? `${name} ${String(params.value)}` : String(params.value);
}
