/**
 * Rich Content Registry (V1 — charts and safe HTML preview).
 *
 * A thin lookup that routes a fenced code block to a typed renderer by its RAW
 * fenced language tag. The registry key must match before
 * `normalizeAiCodeLanguage`'s SQL/SHELL label map runs: SQL/SHELL families
 * never enter the registry and keep the existing proposal/confirm/execute code
 * path. V1 registers `chart-json` and `html`; future artifact types (mermaid,
 * tables, files) join as new handlers without touching the parser core.
 */

import { parseAiChartSpec, type AiChartSpec } from "@/lib/ai/richContent/aiChartSpec";
import { buildSafeHtmlPreview, isAiHtmlPreviewEligible } from "@/lib/ai/richContent/aiHtmlPreview";

/** Segment produced for a successfully parsed chart-json block. */
export interface AiMessageChartSegment {
  type: "chart";
  /** The raw chart-json fence body (preserved for copy / export / debugging). */
  content: string;
  /** Normalized chart spec consumed by {@link buildAiChartOption}. */
  spec: AiChartSpec;
}

/**
 * Segment produced for an eligible ```html block. `document` is the
 * CSP-wrapped standalone shell used for BOTH the iframe preview and the
 * "Save Safe HTML" payload, so the preview and the saved file never drift.
 */
export interface AiMessageHtmlSegment {
  type: "html";
  /** The raw html fence body (what "copy source" puts on the clipboard). */
  content: string;
  /** `buildSafeHtmlPreview(content)` — rendered in the sandboxed iframe. */
  document: string;
}

/** Union of rich segments. */
export type AiMessageRichSegment = AiMessageChartSegment | AiMessageHtmlSegment;

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

function htmlHandler(): AiRichBlockHandler {
  return {
    language: "html",
    parse(content, flags) {
      if (!flags.closed) return null;
      // Over-budget (or empty) bodies stay a plain code segment: still fully
      // visible and copyable, just never handed to the preview pipeline.
      if (!isAiHtmlPreviewEligible(content)) return null;
      return { type: "html", content, document: buildSafeHtmlPreview(content) };
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
  html: htmlHandler(),
};

/** Language tags the rich registry owns (V1: `chart-json`, `html`). */
export function isAiRichBlockLanguage(rawLang: string): boolean {
  return Object.prototype.hasOwnProperty.call(AI_RICH_BLOCK_HANDLERS, rawLang.trim().toLowerCase());
}
