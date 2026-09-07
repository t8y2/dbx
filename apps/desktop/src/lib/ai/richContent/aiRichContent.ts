/**
 * Rich Content Registry (V1 — charts only).
 *
 * A thin lookup that routes a fenced code block to a typed renderer by its RAW
 * fenced language tag. The registry key must match before
 * `normalizeAiCodeLanguage`'s SQL/SHELL label map runs: SQL/SHELL families
 * never enter the registry and keep the existing proposal/confirm/execute code
 * path. V1 registers only `chart-json`; later PRs add `html` (safe preview) and
 * future artifact types as new handlers without touching the parser core.
 */

import { parseAiChartSpec, type AiChartSpec } from "@/lib/ai/richContent/aiChartSpec";

/** Segment produced for a successfully parsed rich block (PR1: charts only). */
export interface AiMessageChartSegment {
  type: "chart";
  /** The raw chart-json fence body (preserved for copy / export / debugging). */
  content: string;
  /** Normalized chart spec consumed by {@link buildAiChartOption}. */
  spec: AiChartSpec;
}

/** Union of rich segments; V1 has only the chart member. */
export type AiMessageRichSegment = AiMessageChartSegment;

export interface AiRichBlockFlags {
  /**
   * True only when the closing fence has arrived. Handlers must not be invoked
   * for an unfinished fence: a half-open block stays a plain code segment
   * (streaming). The renderer normally enforces this gate before calling
   * `parse`, but a handler may also defensively reject `closed: false` — the
   * double check is cheap and keeps handlers safe if a future caller skips the
   * renderer gate.
   */
  closed: boolean;
}

export interface AiRichBlockHandler<T = AiMessageRichSegment> {
  /** The raw fenced language tag this handler owns (lowercase). */
  language: string;
  parse: (content: string, flags: AiRichBlockFlags) => T | null;
}

function chartHandler(): AiRichBlockHandler {
  return {
    language: "chart-json",
    parse(content, flags) {
      if (!flags.closed) return null;
      const result = parseAiChartSpec(content);
      if (!result.ok) return null;
      return { type: "chart", content, spec: result.spec };
    },
  };
}

/**
 * Registry keyed by the raw fenced lang (lowercased, trimmed). The caller in
 * `aiMessageRender.ts` performs the lookup BEFORE `normalizeAiCodeLanguage`, so
 * a SQL/SHELL tag never collides with a rich tag.
 */
export const AI_RICH_BLOCK_HANDLERS: Record<string, AiRichBlockHandler> = {
  "chart-json": chartHandler(),
};

/** Language tags the rich registry owns (V1: `chart-json`). */
export function isAiRichBlockLanguage(rawLang: string): boolean {
  return Object.prototype.hasOwnProperty.call(AI_RICH_BLOCK_HANDLERS, rawLang.trim().toLowerCase());
}
