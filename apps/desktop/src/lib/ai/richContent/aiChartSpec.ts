/**
 * Controlled chart-json protocol (V1).
 *
 * The AI emits a fenced ```chart-json block and the frontend parses it with a
 * deliberately narrow, discriminable schema instead of forwarding a raw
 * ECharts option. Unknown shapes are rejected deterministically and fall back
 * to the plain code segment so the original data stays visible.
 *
 * The types below describe the NORMALIZED shape: after a successful parse,
 * `series[].data` and pie `data[].value` are always finite `number`s. The
 * raw JSON input may carry `number` or a coercible numeric string for those
 * fields; the `string` alternatives in the input rules (documented inline)
 * refer to that allowed raw input only.
 */

/** Version gate: V1 only understands version 1; the protocol requires an explicit `version` field. */
export const AI_CHART_VERSION = 1;

/** Max raw JSON length (characters) — protects JSON.parse and ECharts from giant inputs. */
export const AI_CHART_MAX_JSON_CHARS = 256 * 1024;
/** Max series in a line/bar chart. */
export const AI_CHART_MAX_SERIES = 8;
/** Max points in one series `data` array or in `xAxis.values`. */
export const AI_CHART_MAX_POINTS_PER_ARRAY = 5000;
/** Max total data points across all line/bar series. */
export const AI_CHART_MAX_TOTAL_POINTS = 10_000;
/** Max length of a single category axis value string. */
export const AI_CHART_MAX_CATEGORY_STRING_LENGTH = 256;

interface LineBarAiChartSpec {
  version: 1;
  type: "line" | "bar";
  title?: string;
  /** Required, non-empty. Category axis values are kept as-is (never coerced to numbers). */
  xAxis: {
    label?: string;
    values: (string | number)[];
  };
  yAxis?: {
    label?: string;
  };
  /** At least one series; each `data` length must equal `xAxis.values` length. */
  series: {
    name: string;
    data: number[];
  }[];
}

interface PieAiChartSpec {
  version: 1;
  type: "pie";
  title?: string;
  /** Non-empty. No `series` field on a pie. */
  data: {
    name: string;
    value: number;
  }[];
}

/** Normalized chart spec accepted by {@link buildAiChartOption}. */
export type AiChartSpec = LineBarAiChartSpec | PieAiChartSpec;

export type AiChartSpecResult = { ok: true; spec: AiChartSpec } | { ok: false; reason: string; raw: string };

/**
 * Parse and validate a ```chart-json fence body.
 *
 * Rules (PRD "chart-json 受控 schema"):
 * - JSON.parse failure → deterministic `{ ok: false, reason: "invalid JSON" }`.
 * - `version` is a REQUIRED protocol field; V1 only supports 1. A missing
 *   `version` is rejected with `"chart version is required"`; an explicit value
 *   !== 1 is rejected with `"unsupported chart version: X"`.
 * - `xAxis.values` (category axis) keeps `string | number` values as-is — never
 *   numeric coercion — only requiring non-empty, within bounds, and each string
 *   ≤ 256 chars.
 * - `series[].data` / pie `data[].value` (numeric columns) accept `number` or a
 *   coercible numeric string; `"NaN"`, `"Infinity"`, and non-coercible strings
 *   reject the whole block. Normalized output always uses `number`.
 * - line/bar: `xAxis.values` required & non-empty; `series` ≥ 1; each series
 *   `data.length === xAxis.values.length`; data may be negative.
 * - pie: `data` ≥ 1; a single `value === 0` is allowed, but a negative value or
 *   an all-zero dataset is rejected (no proportional meaning).
 * - Input limits: raw JSON ≤ 256KB; line/bar series ≤ 8; each data/values array
 *   ≤ 5000 points; total line/bar points ≤ 10000. Oversize is a deterministic
 *   rejection — never downsample or mutate the AI's original data.
 */
export function parseAiChartSpec(content: string): AiChartSpecResult {
  const raw = content.trim();
  if (!raw) return { ok: false, reason: "empty chart spec", raw };
  if (raw.length > AI_CHART_MAX_JSON_CHARS) return { ok: false, reason: "chart spec exceeds 256KB limit", raw };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON", raw };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "chart spec must be a JSON object", raw };
  }

  const spec = parsed as Record<string, unknown>;

  // Version is a required protocol field: a missing version is a malformed
  // block, and only version 1 is supported in V1.
  if (spec.version === undefined) {
    return { ok: false, reason: "chart version is required", raw };
  }
  if (spec.version !== AI_CHART_VERSION) {
    return { ok: false, reason: `unsupported chart version: ${String(spec.version)}`, raw };
  }

  const type = spec.type;
  if (type === "pie") {
    return parsePieSpec(spec, raw);
  }
  if (type === "line" || type === "bar") {
    return parseLineBarSpec(spec, raw);
  }
  return { ok: false, reason: `unsupported chart type: ${String(type)}`, raw };
}

/** Numeric columns: number or coercible numeric string; NaN/Infinity/non-numeric → null. */
function coerceNumericColumn(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

/** Optional string field validator. */
function optionalString(value: unknown, field: string): { ok: true; value?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, reason: `${field} must be a string` };
}

function parseLineBarSpec(spec: Record<string, unknown>, raw: string): AiChartSpecResult {
  const titleResult = optionalString(spec.title, "title");
  if (!titleResult.ok) return { ok: false, reason: titleResult.reason, raw };
  const title = titleResult.value;

  const xAxis = spec.xAxis;
  if (typeof xAxis !== "object" || xAxis === null || Array.isArray(xAxis)) {
    return { ok: false, reason: "line/bar chart requires an xAxis object", raw };
  }
  const xAxisRecord = xAxis as Record<string, unknown>;

  const values = xAxisRecord.values;
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, reason: "xAxis.values must be a non-empty array", raw };
  }
  if (values.length > AI_CHART_MAX_POINTS_PER_ARRAY) {
    return { ok: false, reason: "xAxis.values exceeds 5000 points", raw };
  }
  for (const value of values) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return { ok: false, reason: "xAxis.values contains a non-finite number", raw };
      continue;
    }
    if (typeof value === "string") {
      if (value.length > AI_CHART_MAX_CATEGORY_STRING_LENGTH) {
        return { ok: false, reason: "xAxis.values contains an over-long category string", raw };
      }
      continue;
    }
    return { ok: false, reason: "xAxis.values must contain only strings or numbers", raw };
  }
  // Category values stay as-is (no numeric coercion) — the PRD's "分类轴不做数值化".

  const xAxisLabelResult = optionalString(xAxisRecord.label, "xAxis.label");
  if (!xAxisLabelResult.ok) return { ok: false, reason: xAxisLabelResult.reason, raw };

  let normalizedYAxis: LineBarAiChartSpec["yAxis"] | undefined;
  const yAxis = spec.yAxis;
  if (yAxis !== undefined) {
    if (typeof yAxis !== "object" || yAxis === null || Array.isArray(yAxis)) {
      return { ok: false, reason: "yAxis must be an object", raw };
    }
    const yAxisRecord = yAxis as Record<string, unknown>;
    const yAxisLabelResult = optionalString(yAxisRecord.label, "yAxis.label");
    if (!yAxisLabelResult.ok) return { ok: false, reason: yAxisLabelResult.reason, raw };
    normalizedYAxis = { label: yAxisLabelResult.value };
  }

  const series = spec.series;
  if (!Array.isArray(series) || series.length === 0) {
    return { ok: false, reason: "line/bar chart requires a non-empty series array", raw };
  }
  if (series.length > AI_CHART_MAX_SERIES) {
    return { ok: false, reason: "line/bar chart exceeds 8 series", raw };
  }

  const normalizedSeries: LineBarAiChartSpec["series"] = [];
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
    return { ok: false, reason: "chart exceeds 10000 total data points", raw };
  }

  const result: LineBarAiChartSpec = {
    version: 1,
    type: spec.type as "line" | "bar",
    xAxis: {
      ...(xAxisLabelResult.value !== undefined ? { label: xAxisLabelResult.value } : {}),
      values: values as (string | number)[],
    },
    series: normalizedSeries,
  };
  if (title !== undefined) result.title = title;
  if (normalizedYAxis !== undefined) result.yAxis = normalizedYAxis;
  return { ok: true, spec: result };
}

function parsePieSpec(spec: Record<string, unknown>, raw: string): AiChartSpecResult {
  const titleResult = optionalString(spec.title, "title");
  if (!titleResult.ok) return { ok: false, reason: titleResult.reason, raw };
  const title = titleResult.value;

  const data = spec.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, reason: "pie chart requires a non-empty data array", raw };
  }
  if (data.length > AI_CHART_MAX_POINTS_PER_ARRAY) {
    return { ok: false, reason: "pie data exceeds 5000 entries", raw };
  }

  const normalizedData: PieAiChartSpec["data"] = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `pie data[${i}] must be an object`, raw };
    }
    const entryRecord = entry as Record<string, unknown>;
    const nameResult = optionalString(entryRecord.name, `pie data[${i}].name`);
    if (!nameResult.ok) return { ok: false, reason: nameResult.reason, raw };
    const value = coerceNumericColumn(entryRecord.value);
    if (value === null) {
      return { ok: false, reason: `pie data[${i}].value must be a finite number`, raw };
    }
    if (value < 0) {
      return { ok: false, reason: "pie data values must not be negative", raw };
    }
    sum += value;
    normalizedData.push({ name: nameResult.value ?? "", value });
  }
  if (sum === 0) {
    return { ok: false, reason: "pie chart must not have all-zero values", raw };
  }

  const result: PieAiChartSpec = { version: 1, type: "pie", data: normalizedData };
  if (title !== undefined) result.title = title;
  return { ok: true, spec: result };
}
