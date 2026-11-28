/**
 * Parser for the `{ name, value }`-only family: `pie` and `funnel`.
 *
 * Both are proportion/part-of-whole charts that carry no axis and no series, so
 * they share the same payload validator. They differ in one rule: a funnel is an
 * ordered magnitude cascade, so a negative stage is meaningless in the same way
 * a negative slice is — both reject negatives, but funnel additionally caps the
 * stage count because a 500-stage funnel cannot be read.
 */

import { AI_CHART_MAX_FUNNEL_ENTRIES, AI_CHART_MAX_POINTS_PER_ARRAY, coerceNumericColumn, optionalString, type AiChartSpecResult, type FunnelAiChartSpec, type PieAiChartSpec } from "@/lib/ai/richContent/aiChartShared";

interface NamedValue {
  name: string;
  value: number;
}

export function parsePieSpec(spec: Record<string, unknown>, raw: string): AiChartSpecResult {
  const parsed = parseNamedValues(spec, raw, {
    type: "pie",
    label: "pie",
    maxEntries: AI_CHART_MAX_POINTS_PER_ARRAY,
    maxEntriesReason: `pie data exceeds ${AI_CHART_MAX_POINTS_PER_ARRAY} entries`,
  });
  if (!parsed.ok) return parsed;
  const result: PieAiChartSpec = { version: 1, type: "pie", data: parsed.data };
  if (parsed.title !== undefined) result.title = parsed.title;
  return { ok: true, spec: result };
}

export function parseFunnelSpec(spec: Record<string, unknown>, raw: string): AiChartSpecResult {
  const parsed = parseNamedValues(spec, raw, {
    type: "funnel",
    label: "funnel",
    maxEntries: AI_CHART_MAX_FUNNEL_ENTRIES,
    maxEntriesReason: `funnel data exceeds ${AI_CHART_MAX_FUNNEL_ENTRIES} stages`,
  });
  if (!parsed.ok) return parsed;
  const result: FunnelAiChartSpec = { version: 1, type: "funnel", data: parsed.data };
  if (parsed.title !== undefined) result.title = parsed.title;
  return { ok: true, spec: result };
}

interface NamedValueRules {
  type: "pie" | "funnel";
  label: string;
  maxEntries: number;
  maxEntriesReason: string;
}

function parseNamedValues(spec: Record<string, unknown>, raw: string, rules: NamedValueRules): { ok: true; title?: string; data: NamedValue[] } | { ok: false; reason: string; raw: string } {
  const titleResult = optionalString(spec.title, "title");
  if (!titleResult.ok) return { ok: false, reason: titleResult.reason, raw };

  const data = spec.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, reason: `${rules.label} chart requires a non-empty data array`, raw };
  }
  if (data.length > rules.maxEntries) {
    return { ok: false, reason: rules.maxEntriesReason, raw };
  }

  const normalized: NamedValue[] = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `${rules.label} data[${i}] must be an object`, raw };
    }
    const record = entry as Record<string, unknown>;
    const nameResult = optionalString(record.name, `${rules.label} data[${i}].name`);
    if (!nameResult.ok) return { ok: false, reason: nameResult.reason, raw };
    const value = coerceNumericColumn(record.value);
    if (value === null) {
      return { ok: false, reason: `${rules.label} data[${i}].value must be a finite number`, raw };
    }
    if (value < 0) {
      return { ok: false, reason: `${rules.label} data values must not be negative`, raw };
    }
    sum += value;
    normalized.push({ name: nameResult.value ?? "", value });
  }
  if (sum === 0) {
    return { ok: false, reason: `${rules.label} chart must not have all-zero values`, raw };
  }

  return { ok: true, title: titleResult.value, data: normalized };
}
