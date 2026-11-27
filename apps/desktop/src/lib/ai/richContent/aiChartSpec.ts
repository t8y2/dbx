/**
 * Controlled chart-json protocol (V1).
 *
 * The AI emits a fenced ```chart-json block and the frontend parses it with a
 * deliberately narrow, discriminable schema instead of forwarding a raw
 * ECharts option. Unknown shapes are rejected deterministically and fall back
 * to the plain code segment so the original data stays visible.
 *
 * This module owns only the protocol's outer contract — the version gate and
 * the `type` dispatch. Each chart family validates its own payload:
 *
 * - `aiChartSpecs/cartesian.ts` — `line` / `bar` / `pictorialBar`
 * - `aiChartSpecs/namedValue.ts` — `pie` / `funnel`
 * - `aiChartSpecs/scatter.ts`   — `scatter`
 * - `aiChartSpecs/heatmap.ts`   — `heatmap`
 *
 * Adding a type is: one parser module + one dispatch line here + one option
 * builder in `aiChartOptions/` + its ECharts module registration in
 * `AiChartRenderer.vue`. The rich-content registry (`aiRichContent.ts`), the
 * renderer's segment plumbing and the conversation export are untouched.
 *
 * `version` stays 1 for these additions on purpose: a new `type` only widens
 * what is accepted, so an older DBX that does not know it rejects the block and
 * shows the original JSON — a graceful degradation, not a protocol break.
 */

import { parseCartesianSpec } from "@/lib/ai/richContent/aiChartSpecs/cartesian";
import { parseHeatmapSpec } from "@/lib/ai/richContent/aiChartSpecs/heatmap";
import { parseFunnelSpec, parsePieSpec } from "@/lib/ai/richContent/aiChartSpecs/namedValue";
import { parseScatterSpec } from "@/lib/ai/richContent/aiChartSpecs/scatter";
import { AI_CHART_MAX_JSON_CHARS, AI_CHART_VERSION, type AiChartSpecResult } from "@/lib/ai/richContent/aiChartShared";

export * from "@/lib/ai/richContent/aiChartShared";

/**
 * Parse and validate a ```chart-json fence body.
 *
 * Rules (unchanged from V1 unless a chart family documents otherwise):
 * - JSON.parse failure → deterministic `{ ok: false, reason: "invalid JSON" }`.
 * - `version` is a REQUIRED protocol field; only 1 is accepted. A missing
 *   `version` is rejected with `"chart version is required"`; an explicit value
 *   !== 1 is rejected with `"unsupported chart version: X"`.
 * - Unknown `type` → `"unsupported chart type: X"` (never a partial render).
 * - Every family keeps category values as-is (no numeric coercion) and
 *   normalizes numeric columns to finite `number`s; anything else rejects the
 *   whole block. Oversize is also a deterministic rejection — never downsample
 *   or mutate the AI's original data.
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
  if (type === "pie") return parsePieSpec(spec, raw);
  if (type === "funnel") return parseFunnelSpec(spec, raw);
  if (type === "scatter") return parseScatterSpec(spec, raw);
  if (type === "heatmap") return parseHeatmapSpec(spec, raw);
  // The `line/bar` label reproduces the V1 rejection reasons byte-for-byte
  // ("line/bar chart requires an xAxis object", "... exceeds 8 series"). Those
  // strings are part of the parser's observable output, and the existing line/bar
  // behaviour is required to stay unchanged by the protocol's compatibility rule.
  if (type === "line" || type === "bar") return parseCartesianSpec(spec, raw, "line/bar", false);
  if (type === "pictorialBar") return parseCartesianSpec(spec, raw, "pictorialBar", true);
  return { ok: false, reason: `unsupported chart type: ${String(type)}`, raw };
}
