/**
 * Safe HTML preview shell (V1).
 *
 * The AI may emit a fenced ```html block. It renders inside a fully sandboxed
 * iframe (`sandbox=""` — no allow-scripts, no allow-same-origin) whose `srcdoc`
 * is wrapped by {@link buildSafeHtmlPreview}. The wrapper inlines a CSP meta
 * that is the single safety boundary in BOTH contexts the content can reach:
 *
 * - the iframe preview (`sandbox=""` already blocks script execution at the
 *   browser level; the CSP additionally blocks network fetches);
 * - the standalone file written by "Save Safe HTML" — out of the sandbox, so
 *   the CSP meta alone must block scripts and network. The saved file is the
 *   wrapped document, never the raw source: once the content leaves the
 *   sandbox its protection is only as strong as this shell.
 *
 * `default-src 'none'` is the fallback for the fetch directives, but
 * `form-action` and `base-uri` do NOT inherit from `default-src`, so both are
 * declared explicitly: `base-uri 'none'` stops `<base>` from rewriting
 * relative URLs, `form-action 'none'` stops `<form action=…>` from submitting
 * to a remote target. There is deliberately no `script-src`: scripts fall back
 * to `default-src 'none'` and are blocked outright.
 */

/** Max raw ```html fence body length (characters) that may enter the iframe `srcdoc`. */
export const AI_HTML_MAX_CONTENT_CHARS = 512 * 1024;

export const AI_HTML_PREVIEW_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

/** True when the raw fence body may be previewed / saved. Oversize stays a plain code segment. */
export function isAiHtmlPreviewEligible(content: string): boolean {
  return content.length > 0 && content.length <= AI_HTML_MAX_CONTENT_CHARS;
}

/**
 * Wrap raw AI HTML in the safe standalone document. The same bytes back BOTH
 * the iframe preview and the "Save Safe HTML" payload, so what is previewed is
 * exactly what gets saved. If the AI content is itself a complete document,
 * the browser's error recovery nests it inside the body while the outer CSP
 * meta still applies document-wide.
 */
export function buildSafeHtmlPreview(content: string): string {
  return ["<!doctype html>", "<html>", "<head>", '<meta charset="utf-8">', `<meta http-equiv="Content-Security-Policy" content="${AI_HTML_PREVIEW_CSP}">`, "</head>", "<body>", content, "</body>", "</html>"].join("\n");
}

/**
 * "Copy source" puts the raw AI HTML on the clipboard where it may later be
 * opened outside DBX. The first copy of a session requires an explicit risk
 * confirmation; the choice is remembered for the session only (it resets when
 * the app restarts), and later copies degrade to a risk toast instead of
 * repeating the confirmation.
 */
let htmlCopyRiskAcknowledged = false;

export function isAiHtmlCopyRiskAcknowledged(): boolean {
  return htmlCopyRiskAcknowledged;
}

export function acknowledgeAiHtmlCopyRisk(): void {
  htmlCopyRiskAcknowledged = true;
}
