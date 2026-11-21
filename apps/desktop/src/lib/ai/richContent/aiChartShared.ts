/**
 * Shared vocabulary for the controlled chart-json protocol (V1).
 *
 * This module is deliberately dependency-free: the per-type parsers in
 * `aiChartSpecs/*`, the dispatcher in `aiChartSpec.ts` and the option builders
 * in `aiChartOptions/*` all import from here, so no module pair can form a
 * runtime import cycle.
 *
 * The interfaces describe the NORMALIZED shape. After a successful parse,
 * numeric columns are always finite `number`s and scatter points are always
 * `AiScatterPoint` objects, regardless of how the model wrote them.
 */

/** Version gate: V1 only understands version 1; the protocol requires an explicit `version` field. */
export const AI_CHART_VERSION = 1;

/** Max raw JSON length (characters) — protects JSON.parse and ECharts from giant inputs. */
export const AI_CHART_MAX_JSON_CHARS = 256 * 1024;
/** Max series in a cartesian chart. */
export const AI_CHART_MAX_SERIES = 8;
/** Max points in one series `data` array or in a category axis `values` array. */
export const AI_CHART_MAX_POINTS_PER_ARRAY = 5000;
/** Max total data points across all cartesian series. */
export const AI_CHART_MAX_TOTAL_POINTS = 10_000;
/** Max length of a single category axis value string. */
export const AI_CHART_MAX_CATEGORY_STRING_LENGTH = 256;
/**
 * Max funnel stages. Beyond a few dozen stages a funnel is unreadable, and the
 * pie-shaped `{ name, value }[]` payload is not otherwise bounded as tightly.
 */
export const AI_CHART_MAX_FUNNEL_ENTRIES = 200;
/**
 * Max distinct categories on ONE heatmap axis.
 *
 * A readability limit, not a performance one: a chat-sized canvas cannot show
 * more than ~100 ticks legibly. Measured against echarts 6.1.0, the render cost
 * follows the number of populated cells (5 000 cells ≈ 130 ms / 670 KB SVG),
 * not the axis vocabulary, because `grid.splitArea` is off.
 */
export const AI_CHART_MAX_HEATMAP_AXIS_CATEGORIES = 100;
/**
 * Max number of heatmap cells.
 *
 * Also the binding constraint in practice: at ~25 JSON characters per
 * `{ "x", "y", "value" }` row, the 256KB raw-JSON gate would fire around 10 000
 * rows, so a lower cap here keeps the rejection reason the meaningful one.
 */
export const AI_CHART_MAX_HEATMAP_CELLS = 5_000;
/**
 * Max `xCategories * yCategories` for a heatmap.
 *
 * Rejects a dense-but-narrow design even when the category count per axis stays
 * low: 100 × 40 = 4 000 slots is the point where cell labels stop being
 * readable on a chat-sized canvas.
 */
export const AI_CHART_MAX_HEATMAP_GRID = 4_000;
/** Max reference lines per chart (they are drawn once, on the first series). */
export const AI_CHART_MAX_MARKS = 10;
/**
 * Max bubble diameter in px. A point larger than the card is not readable, and an
 * unbounded value only pushes ECharts' scale transform to absurd numbers
 * (measured: `size: 1e9` renders a 5e8× scale matrix), so an over-limit size
 * rejects the block like every other budget violation.
 */
export const AI_CHART_MAX_SCATTER_SYMBOL_SIZE = 1_000;
/** Max length of a `path://` symbol definition (inline path data, not a URL). */
export const AI_CHART_MAX_SYMBOL_PATH_LENGTH = 4 * 1024;

/**
 * Symbol names a chart spec may use.
 *
 * Deliberately excludes `image://`: ECharts turns it into an `Image` whose `src`
 * is the given URL (zrender `core/platform.js`), so a data-only chart block would
 * issue a real outbound request — a beacon/leak channel the protocol otherwise
 * does not have. `path://` stays because it is inline path data the path parser
 * consumes, never markup or a URL.
 */
const AI_CHART_SYMBOL_NAMES = new Set(["circle", "rect", "roundRect", "square", "line", "diamond", "pin", "arrow", "triangle", "none"]);

/** A horizontal reference line drawn across the plot at `value` on the value axis. */
export interface AiChartMark {
  name?: string;
  value: number;
}

export type AiChartStep = "start" | "middle" | "end";

interface CartesianBase {
  version: 1;
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
  /** Shared stack id across series (`stack` in ECharts terms). */
  stack?: string;
  /** Horizontal reference lines drawn ONCE for the whole chart (see the option builder). */
  marks?: AiChartMark[];
}

export interface LineBarAiChartSpec extends CartesianBase {
  type: "line" | "bar";
  /** Line only: fill the area under the line. */
  area?: boolean;
  /** Line only: step interpolation. */
  step?: AiChartStep;
}

export interface PictorialBarAiChartSpec extends CartesianBase {
  type: "pictorialBar";
  /** Built-in symbol name or `path://…`. Defaults to `circle` at render time. */
  symbol?: string;
}

export interface PieAiChartSpec {
  version: 1;
  type: "pie";
  title?: string;
  /** Non-empty. No `series` field on a pie. */
  data: {
    name: string;
    value: number;
  }[];
}

/** Slices are funnel stages, so the pie-shaped payload is reused verbatim. */
export interface FunnelAiChartSpec {
  version: 1;
  type: "funnel";
  title?: string;
  data: {
    name: string;
    value: number;
  }[];
}

/** One normalized scatter point; `size` maps to `symbolSize`. */
export interface AiScatterPoint {
  x: number;
  y: number;
  size?: number;
  name?: string;
}

export interface ScatterAiChartSpec {
  version: 1;
  type: "scatter";
  title?: string;
  /** Labels only — both axes are always `type: "value"` on a scatter. */
  xAxis?: {
    label?: string;
  };
  yAxis?: {
    label?: string;
  };
  series: {
    name: string;
    data: AiScatterPoint[];
  }[];
}

/**
 * Heatmap in LONG form: one row per cell, with the axis categories named
 * explicitly. The index-matrix form ECharts natively consumes is built in the
 * option adapter, because a bad index there can only be expressed as a silently
 * blank cell.
 */
export interface HeatmapAiChartSpec {
  version: 1;
  type: "heatmap";
  title?: string;
  xAxis: {
    label?: string;
    values: (string | number)[];
  };
  yAxis: {
    label?: string;
    values: (string | number)[];
  };
  data: {
    x: string | number;
    y: string | number;
    value: number;
  }[];
}

/** Normalized chart spec accepted by the option adapters. */
export type AiChartSpec = LineBarAiChartSpec | PictorialBarAiChartSpec | PieAiChartSpec | FunnelAiChartSpec | ScatterAiChartSpec | HeatmapAiChartSpec;

export type AiChartSpecResult = { ok: true; spec: AiChartSpec } | { ok: false; reason: string; raw: string };

/** Theme input shared by the option adapters. */
export interface AiChartTheme {
  isDark: boolean;
}

/** Numeric columns: number or coercible numeric string; NaN/Infinity/non-numeric → null. */
export function coerceNumericColumn(value: unknown): number | null {
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
export function optionalString(value: unknown, field: string): { ok: true; value?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, reason: `${field} must be a string` };
}

/**
 * Validate a category axis `values` array.
 *
 * Category values stay as-is (no numeric coercion) — the protocol's "分类轴不做数值化"
 * rule. `field` is the user-visible path so the rejection reason stays actionable.
 */
export function readCategoryValues(value: unknown, field: string): { ok: true; values: (string | number)[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, reason: `${field} must be a non-empty array` };
  }
  if (value.length > AI_CHART_MAX_POINTS_PER_ARRAY) {
    return { ok: false, reason: `${field} exceeds ${AI_CHART_MAX_POINTS_PER_ARRAY} points` };
  }
  for (const entry of value) {
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) return { ok: false, reason: `${field} contains a non-finite number` };
      continue;
    }
    if (typeof entry === "string") {
      if (entry.length > AI_CHART_MAX_CATEGORY_STRING_LENGTH) {
        return { ok: false, reason: `${field} contains an over-long category string` };
      }
      continue;
    }
    return { ok: false, reason: `${field} must contain only strings or numbers` };
  }
  return { ok: true, values: value as (string | number)[] };
}

/**
 * Validate the optional `marks` array.
 *
 * Only horizontal reference lines are supported: ECharts' markLine accepts
 * `{ name, yAxis: n }`, NOT `{ name, value }` — the latter logs
 * "Invalid markLine data." and then throws in both dev and production
 * (verified against echarts 6.1.0, see research/echarts6-chart-types.md).
 */
export function readMarks(value: unknown, field: string): { ok: true; marks?: AiChartMark[] } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, reason: `${field} must be an array` };
  if (value.length === 0) return { ok: false, reason: `${field} must not be empty` };
  if (value.length > AI_CHART_MAX_MARKS) {
    return { ok: false, reason: `${field} exceeds ${AI_CHART_MAX_MARKS} marks` };
  }
  const marks: AiChartMark[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `${field}[${i}] must be an object` };
    }
    const record = entry as Record<string, unknown>;
    const nameResult = optionalString(record.name, `${field}[${i}].name`);
    if (!nameResult.ok) return { ok: false, reason: nameResult.reason };
    const markValue = coerceNumericColumn(record.value);
    if (markValue === null) return { ok: false, reason: `${field}[${i}].value must be a finite number` };
    marks.push(nameResult.value === undefined ? { value: markValue } : { name: nameResult.value, value: markValue });
  }
  return { ok: true, marks };
}

/** Optional `stack` field: a non-empty string shared across series. */
export function readStack(value: unknown): { ok: true; stack?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, reason: "stack must be a non-empty string" };
  }
  if (value.length > AI_CHART_MAX_CATEGORY_STRING_LENGTH) {
    return { ok: false, reason: "stack is too long" };
  }
  return { ok: true, stack: value };
}

/**
 * Validate the pictorial symbol.
 *
 * Whitelist-only, because a symbol string reaches the renderer verbatim: the
 * ECharts symbol parser accepts `image://<url>` and assigns it to an `Image.src`,
 * which would turn a chart block into an outbound request (see
 * {@link AI_CHART_SYMBOL_NAMES}).
 */
export function readSymbol(value: unknown): { ok: true; symbol?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, reason: "symbol must be a non-empty string" };
  }
  const symbol = value.trim();
  if (symbol.startsWith("path://")) {
    if (symbol.length > AI_CHART_MAX_SYMBOL_PATH_LENGTH) {
      return { ok: false, reason: `symbol path exceeds ${AI_CHART_MAX_SYMBOL_PATH_LENGTH} characters` };
    }
    return { ok: true, symbol };
  }
  if (AI_CHART_SYMBOL_NAMES.has(symbol)) return { ok: true, symbol };
  return { ok: false, reason: `symbol must be a built-in name or path://, got "${symbol.slice(0, 32)}"` };
}
