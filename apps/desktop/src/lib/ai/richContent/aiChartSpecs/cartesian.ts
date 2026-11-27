/**
 * Parser for the cartesian family: `line`, `bar` and `pictorialBar`.
 *
 * All three share the exact same payload — a non-empty category axis plus one or
 * more equal-length numeric series — so they share one validator. `pictorialBar`
 * differs only in how it is drawn (a symbol instead of a rectangle), which the
 * option adapter handles.
 *
 * The rejection reasons are part of the protocol's observable behaviour (tests
 * and the "fall back to a plain code block" path both key off them), so they are
 * written to stay stable and actionable.
 */

import { AI_CHART_MAX_SERIES, AI_CHART_MAX_TOTAL_POINTS, coerceNumericColumn, optionalString, readCategoryValues, readMarks, readStack, readSymbol, type AiChartStep, type AiChartSpecResult, type LineBarAiChartSpec, type PictorialBarAiChartSpec } from "@/lib/ai/richContent/aiChartShared";

const STEPS: readonly string[] = ["start", "middle", "end"] satisfies AiChartStep[];

export function parseCartesianSpec(spec: Record<string, unknown>, raw: string, label: string, pictorial: boolean): AiChartSpecResult {
  const titleResult = optionalString(spec.title, "title");
  if (!titleResult.ok) return { ok: false, reason: titleResult.reason, raw };
  const title = titleResult.value;

  const xAxis = spec.xAxis;
  if (typeof xAxis !== "object" || xAxis === null || Array.isArray(xAxis)) {
    return { ok: false, reason: `${label} chart requires an xAxis object`, raw };
  }
  const xAxisRecord = xAxis as Record<string, unknown>;

  const valuesResult = readCategoryValues(xAxisRecord.values, "xAxis.values");
  if (!valuesResult.ok) return { ok: false, reason: valuesResult.reason, raw };
  const values = valuesResult.values;

  const xAxisLabelResult = optionalString(xAxisRecord.label, "xAxis.label");
  if (!xAxisLabelResult.ok) return { ok: false, reason: xAxisLabelResult.reason, raw };

  let normalizedYAxis: { label?: string } | undefined;
  const yAxis = spec.yAxis;
  if (yAxis !== undefined) {
    if (typeof yAxis !== "object" || yAxis === null || Array.isArray(yAxis)) {
      return { ok: false, reason: "yAxis must be an object", raw };
    }
    const yAxisLabelResult = optionalString((yAxis as Record<string, unknown>).label, "yAxis.label");
    if (!yAxisLabelResult.ok) return { ok: false, reason: yAxisLabelResult.reason, raw };
    normalizedYAxis = { label: yAxisLabelResult.value };
  }

  const series = spec.series;
  if (!Array.isArray(series) || series.length === 0) {
    return { ok: false, reason: `${label} chart requires a non-empty series array`, raw };
  }
  if (series.length > AI_CHART_MAX_SERIES) {
    return { ok: false, reason: `${label} chart exceeds ${AI_CHART_MAX_SERIES} series`, raw };
  }

  const normalizedSeries: { name: string; data: number[] }[] = [];
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
    if (!Array.isArray(data)) {
      return { ok: false, reason: `series[${i}].data must be an array`, raw };
    }
    if (data.length !== values.length) {
      return { ok: false, reason: `series[${i}].data length does not match xAxis.values`, raw };
    }
    const normalizedData: number[] = [];
    for (const point of data) {
      const numeric = coerceNumericColumn(point);
      if (numeric === null) {
        return { ok: false, reason: `series[${i}].data contains a non-numeric value`, raw };
      }
      normalizedData.push(numeric);
    }
    totalPoints += normalizedData.length;
    normalizedSeries.push({ name: nameResult.value ?? "", data: normalizedData });
  }
  if (totalPoints > AI_CHART_MAX_TOTAL_POINTS) {
    return { ok: false, reason: `chart exceeds ${AI_CHART_MAX_TOTAL_POINTS} total data points`, raw };
  }

  const stackResult = readStack(spec.stack);
  if (!stackResult.ok) return { ok: false, reason: stackResult.reason, raw };

  const marksResult = readMarks(spec.marks, "marks");
  if (!marksResult.ok) return { ok: false, reason: marksResult.reason, raw };

  const base: Omit<LineBarAiChartSpec, "type"> = {
    version: 1,
    xAxis: {
      ...(xAxisLabelResult.value !== undefined ? { label: xAxisLabelResult.value } : {}),
      values,
    },
    series: normalizedSeries,
  };
  if (title !== undefined) base.title = title;
  if (normalizedYAxis !== undefined) base.yAxis = normalizedYAxis;
  if (stackResult.stack !== undefined) base.stack = stackResult.stack;
  if (marksResult.marks !== undefined) base.marks = marksResult.marks;

  // `area` / `step` are line-only, and `pictorialBar` is a bar: accepting either
  // there would silently drop the model's intent (nothing renders differently and
  // the fallback code segment never shows what was asked for), so both are
  // validated before the pictorial branch.
  const family: "line" | "bar" | "pictorialBar" = pictorial ? "pictorialBar" : (spec.type as "line" | "bar");
  const areaResult = readAreaField(spec.area, family);
  if (!areaResult.ok) return { ok: false, reason: areaResult.reason, raw };
  const stepResult = readStepField(spec.step, family);
  if (!stepResult.ok) return { ok: false, reason: stepResult.reason, raw };

  if (pictorial) {
    const symbolResult = readSymbol(spec.symbol);
    if (!symbolResult.ok) return { ok: false, reason: symbolResult.reason, raw };
    const pictorialSpec: PictorialBarAiChartSpec = { ...base, type: "pictorialBar" };
    if (symbolResult.symbol !== undefined) pictorialSpec.symbol = symbolResult.symbol;
    return { ok: true, spec: pictorialSpec };
  }

  const cartesianSpec: LineBarAiChartSpec = { ...base, type: spec.type as "line" | "bar" };
  if (areaResult.area !== undefined) cartesianSpec.area = areaResult.area;
  if (stepResult.step !== undefined) cartesianSpec.step = stepResult.step;
  return { ok: true, spec: cartesianSpec };
}

function readAreaField(value: unknown, family: "line" | "bar" | "pictorialBar"): { ok: true; area?: boolean } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "boolean") return { ok: false, reason: "area must be a boolean" };
  if (family !== "line") return { ok: false, reason: "area is only supported on line charts" };
  return { ok: true, area: value };
}

function readStepField(value: unknown, family: "line" | "bar" | "pictorialBar"): { ok: true; step?: AiChartStep } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !STEPS.includes(value)) {
    return { ok: false, reason: `step must be one of ${STEPS.join(", ")}` };
  }
  if (family !== "line") return { ok: false, reason: "step is only supported on line charts" };
  return { ok: true, step: value as AiChartStep };
}
