/**
 * Parser for the `scatter` chart.
 *
 * A scatter plots numeric x against numeric y, so the protocol drops the
 * category axis entirely and carries points instead. Three input forms are
 * accepted and all normalize to {@link AiScatterPoint}:
 *
 * - `[x, y]`                     — plain point
 * - `[x, y, size]`               — bubble; `size` becomes the symbol size
 * - `{ name, value: [x, y], size? }` — named point (tooltip shows the name)
 *
 * Array and object forms may NOT be mixed inside one series: ECharts resolves
 * tooltips per item shape, so a mixed payload would render two different tooltip
 * conventions in one chart. Mixing is rejected rather than silently coerced.
 */

import { AI_CHART_MAX_POINTS_PER_ARRAY, AI_CHART_MAX_SCATTER_SYMBOL_SIZE, AI_CHART_MAX_SERIES, AI_CHART_MAX_TOTAL_POINTS, coerceNumericColumn, optionalString, type AiChartSpecResult, type AiScatterPoint, type ScatterAiChartSpec } from "@/lib/ai/richContent/aiChartShared";

export function parseScatterSpec(spec: Record<string, unknown>, raw: string): AiChartSpecResult {
  const titleResult = optionalString(spec.title, "title");
  if (!titleResult.ok) return { ok: false, reason: titleResult.reason, raw };

  // Axis labels only — a scatter's axes are always numeric, so accepting
  // `values` here would imply a category scatter that the adapter cannot honor.
  const xAxisResult = readAxisLabel(spec.xAxis, "xAxis");
  if (!xAxisResult.ok) return { ok: false, reason: xAxisResult.reason, raw };
  const yAxisResult = readAxisLabel(spec.yAxis, "yAxis");
  if (!yAxisResult.ok) return { ok: false, reason: yAxisResult.reason, raw };

  const series = spec.series;
  if (!Array.isArray(series) || series.length === 0) {
    return { ok: false, reason: "scatter chart requires a non-empty series array", raw };
  }
  if (series.length > AI_CHART_MAX_SERIES) {
    return { ok: false, reason: `scatter chart exceeds ${AI_CHART_MAX_SERIES} series`, raw };
  }

  const normalizedSeries: { name: string; data: AiScatterPoint[] }[] = [];
  let totalPoints = 0;
  for (let i = 0; i < series.length; i++) {
    const entry = series[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `series[${i}] must be an object`, raw };
    }
    const seriesRecord = entry as Record<string, unknown>;
    const nameResult = optionalString(seriesRecord.name, `series[${i}].name`);
    if (!nameResult.ok) return { ok: false, reason: nameResult.reason, raw };
    const data = seriesRecord.data;
    if (!Array.isArray(data) || data.length === 0) {
      return { ok: false, reason: `series[${i}].data must be a non-empty array`, raw };
    }
    if (data.length > AI_CHART_MAX_POINTS_PER_ARRAY) {
      return { ok: false, reason: `series[${i}].data exceeds ${AI_CHART_MAX_POINTS_PER_ARRAY} points`, raw };
    }

    const pointsResult = readPoints(data, i);
    if (!pointsResult.ok) return { ok: false, reason: pointsResult.reason, raw };

    totalPoints += pointsResult.points.length;
    normalizedSeries.push({ name: nameResult.value ?? "", data: pointsResult.points });
  }
  if (totalPoints > AI_CHART_MAX_TOTAL_POINTS) {
    return { ok: false, reason: `chart exceeds ${AI_CHART_MAX_TOTAL_POINTS} total data points`, raw };
  }

  const result: ScatterAiChartSpec = { version: 1, type: "scatter", series: normalizedSeries };
  if (titleResult.value !== undefined) result.title = titleResult.value;
  if (xAxisResult.label !== undefined) result.xAxis = { label: xAxisResult.label };
  if (yAxisResult.label !== undefined) result.yAxis = { label: yAxisResult.label };
  return { ok: true, spec: result };
}

function readAxisLabel(value: unknown, field: string): { ok: true; label?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: `${field} must be an object` };
  }
  const record = value as Record<string, unknown>;
  if (record.values !== undefined) {
    return { ok: false, reason: `${field}.values is not supported on a scatter (both axes are numeric)` };
  }
  const labelResult = optionalString(record.label, `${field}.label`);
  if (!labelResult.ok) return { ok: false, reason: labelResult.reason };
  return { ok: true, label: labelResult.value };
}

function readPoints(data: unknown[], seriesIndex: number): { ok: true; points: AiScatterPoint[] } | { ok: false; reason: string } {
  let shape: "tuple" | "object" | undefined;
  const points: AiScatterPoint[] = [];

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    const isTuple = Array.isArray(entry);
    const isObject = typeof entry === "object" && entry !== null && !isTuple;
    if (!isTuple && !isObject) {
      return { ok: false, reason: `series[${seriesIndex}].data[${i}] must be an array or an object` };
    }
    const entryShape = isTuple ? "tuple" : "object";
    if (shape === undefined) shape = entryShape;
    if (shape !== entryShape) {
      return {
        ok: false,
        reason: `series[${seriesIndex}].data mixes array and object points`,
      };
    }

    if (isTuple) {
      const tuple = entry as unknown[];
      if (tuple.length !== 2 && tuple.length !== 3) {
        return { ok: false, reason: `series[${seriesIndex}].data[${i}] must be [x, y] or [x, y, size]` };
      }
      const x = coerceNumericColumn(tuple[0]);
      const y = coerceNumericColumn(tuple[1]);
      if (x === null || y === null) {
        return { ok: false, reason: `series[${seriesIndex}].data[${i}] must have finite numeric x and y` };
      }
      const point: AiScatterPoint = { x, y };
      if (tuple.length === 3) {
        const size = coerceNumericColumn(tuple[2]);
        if (size === null || size < 0 || size > AI_CHART_MAX_SCATTER_SYMBOL_SIZE) {
          return {
            ok: false,
            reason: `series[${seriesIndex}].data[${i}] size must be a non-negative finite number up to ${AI_CHART_MAX_SCATTER_SYMBOL_SIZE}`,
          };
        }
        point.size = size;
      }
      points.push(point);
      continue;
    }

    const record = entry as Record<string, unknown>;
    const nameResult = optionalString(record.name, `series[${seriesIndex}].data[${i}].name`);
    if (!nameResult.ok) return { ok: false, reason: nameResult.reason };
    const value = record.value;
    if (!Array.isArray(value) || value.length !== 2) {
      return { ok: false, reason: `series[${seriesIndex}].data[${i}].value must be [x, y]` };
    }
    const x = coerceNumericColumn(value[0]);
    const y = coerceNumericColumn(value[1]);
    if (x === null || y === null) {
      return { ok: false, reason: `series[${seriesIndex}].data[${i}].value must have finite numeric x and y` };
    }
    const point: AiScatterPoint = { x, y };
    if (nameResult.value !== undefined) point.name = nameResult.value;
    if (record.size !== undefined) {
      const size = coerceNumericColumn(record.size);
      if (size === null || size < 0 || size > AI_CHART_MAX_SCATTER_SYMBOL_SIZE) {
        return {
          ok: false,
          reason: `series[${seriesIndex}].data[${i}].size must be a non-negative finite number up to ${AI_CHART_MAX_SCATTER_SYMBOL_SIZE}`,
        };
      }
      point.size = size;
    }
    points.push(point);
  }

  return { ok: true, points };
}
