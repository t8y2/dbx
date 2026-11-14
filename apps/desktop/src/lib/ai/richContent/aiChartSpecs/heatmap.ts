/**
 * Parser for the `heatmap` chart, in LONG form: one `{ x, y, value }` row per
 * cell, with the two category vocabularies declared separately.
 *
 * Why long form and not ECharts' native index matrix:
 * - a bad index in the matrix form can only be expressed as a silently blank
 *   cell, while a bad `{ x, y }` can be rejected with a reason naming the value;
 * - the model writes `{ x: "Mon", y: "9am", value: 12 }` far more reliably than
 *   it computes positions in a category index space.
 *
 * The adapter converts to indices; see `aiChartOptions/heatmap.ts`.
 *
 * ECharts' cartesian heatmap has two hard requirements that are DEV-ONLY checks
 * in echarts 6.1.0 (verified): both axes must be `category` with
 * `boundaryGap: true`, and a `visualMap` must be registered. In production those
 * violations render garbage silently, so the protocol enforces the data-side
 * preconditions here — by construction both axes are categorical and every cell
 * names its categories.
 */

import { AI_CHART_MAX_CATEGORY_STRING_LENGTH, AI_CHART_MAX_HEATMAP_AXIS_CATEGORIES, AI_CHART_MAX_HEATMAP_CELLS, AI_CHART_MAX_HEATMAP_GRID, coerceNumericColumn, optionalString, readCategoryValues, type AiChartSpecResult, type HeatmapAiChartSpec } from "@/lib/ai/richContent/aiChartShared";

export function parseHeatmapSpec(spec: Record<string, unknown>, raw: string): AiChartSpecResult {
  const titleResult = optionalString(spec.title, "title");
  if (!titleResult.ok) return { ok: false, reason: titleResult.reason, raw };

  const xAxisResult = readHeatmapAxis(spec.xAxis, "xAxis");
  if (!xAxisResult.ok) return { ok: false, reason: xAxisResult.reason, raw };
  const yAxisResult = readHeatmapAxis(spec.yAxis, "yAxis");
  if (!yAxisResult.ok) return { ok: false, reason: yAxisResult.reason, raw };

  // A sparse grid with a huge vocabulary is the real resource risk (the axes
  // alone would force ECharts to lay out far more slots than there is data).
  if (xAxisResult.values.length * yAxisResult.values.length > AI_CHART_MAX_HEATMAP_GRID) {
    return {
      ok: false,
      reason: `heatmap grid exceeds ${AI_CHART_MAX_HEATMAP_GRID} (xAxis.values × yAxis.values)`,
      raw,
    };
  }

  const xIndex = categoryIndex(xAxisResult.values);
  const yIndex = categoryIndex(yAxisResult.values);

  const data = spec.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, reason: "heatmap chart requires a non-empty data array", raw };
  }
  if (data.length > AI_CHART_MAX_HEATMAP_CELLS) {
    return { ok: false, reason: `heatmap data exceeds ${AI_CHART_MAX_HEATMAP_CELLS} cells`, raw };
  }

  const normalized: HeatmapAiChartSpec["data"] = [];
  // Two rows naming the same (x, y) cell would paint on top of each other and the
  // visible value would depend on ECharts' internal ordering rather than on the
  // model's intent, so a duplicate is rejected instead of silently collapsed.
  const populatedCells = new Set<string>();
  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `heatmap data[${i}] must be an object`, raw };
    }
    const record = entry as Record<string, unknown>;
    if (!isCategoryKey(record.x) || !isCategoryKey(record.y)) {
      return { ok: false, reason: `heatmap data[${i}] requires string or number x and y`, raw };
    }
    if (!xIndex.has(categoryKey(record.x))) {
      return { ok: false, reason: `heatmap data[${i}].x "${String(record.x)}" is not in xAxis.values`, raw };
    }
    if (!yIndex.has(categoryKey(record.y))) {
      return { ok: false, reason: `heatmap data[${i}].y "${String(record.y)}" is not in yAxis.values`, raw };
    }
    const cellKey = `${categoryKey(record.x)}\u0000${categoryKey(record.y)}`;
    if (populatedCells.has(cellKey)) {
      return { ok: false, reason: `heatmap data[${i}] repeats the cell (${String(record.x)}, ${String(record.y)})`, raw };
    }
    populatedCells.add(cellKey);
    const value = coerceNumericColumn(record.value);
    if (value === null) {
      return { ok: false, reason: `heatmap data[${i}].value must be a finite number`, raw };
    }
    normalized.push({ x: record.x, y: record.y, value });
  }

  const result: HeatmapAiChartSpec = {
    version: 1,
    type: "heatmap",
    xAxis: xAxisResult.normalized,
    yAxis: yAxisResult.normalized,
    data: normalized,
  };
  if (titleResult.value !== undefined) result.title = titleResult.value;
  return { ok: true, spec: result };
}

interface NormalizedHeatmapAxis {
  label?: string;
  values: (string | number)[];
}

function readHeatmapAxis(value: unknown, field: string): { ok: true; normalized: NormalizedHeatmapAxis; values: (string | number)[] } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: `heatmap chart requires a ${field} object` };
  }
  const record = value as Record<string, unknown>;
  const labelResult = optionalString(record.label, `${field}.label`);
  if (!labelResult.ok) return { ok: false, reason: labelResult.reason };
  const valuesResult = readCategoryValues(record.values, `${field}.values`);
  if (!valuesResult.ok) return { ok: false, reason: valuesResult.reason };
  if (valuesResult.values.length > AI_CHART_MAX_HEATMAP_AXIS_CATEGORIES) {
    return { ok: false, reason: `${field}.values exceeds ${AI_CHART_MAX_HEATMAP_AXIS_CATEGORIES} categories` };
  }
  const seen = new Set<string>();
  for (const category of valuesResult.values) {
    const key = categoryKey(category);
    if (seen.has(key)) {
      // Duplicates would make ECharts' ordinal lookup ambiguous, so a repeated
      // category silently collapses rows. Rejecting keeps the model honest.
      return { ok: false, reason: `${field}.values contains the duplicate category "${key}"` };
    }
    seen.add(key);
    if (key.length > AI_CHART_MAX_CATEGORY_STRING_LENGTH) {
      return { ok: false, reason: `${field}.values contains an over-long category string` };
    }
  }
  const normalized: NormalizedHeatmapAxis = { values: valuesResult.values };
  if (labelResult.value !== undefined) normalized.label = labelResult.value;
  return { ok: true, normalized, values: valuesResult.values };
}

function isCategoryKey(value: unknown): value is string | number {
  if (typeof value === "string") return value.length > 0;
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * ECharts' OrdinalMeta keys categories in a hash map, so `1` and `"1"` address
 * the same slot. Matching through the same string projection keeps the spec
 * honest about what the renderer will actually do.
 */
function categoryKey(value: string | number): string {
  return String(value);
}

function categoryIndex(values: (string | number)[]): Map<string, number> {
  const index = new Map<string, number>();
  values.forEach((value, position) => index.set(categoryKey(value), position));
  return index;
}
