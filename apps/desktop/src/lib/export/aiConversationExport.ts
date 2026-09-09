import { formatAiInlineMarkdown, escapeHtml } from "@/lib/ai/aiMarkdown";
import { AI_HTML_PREVIEW_CSP } from "@/lib/ai/richContent/aiHtmlPreview";
import { compactLocalTimestamp, sanitizeExportBaseName } from "./saveTextFile";

/**
 * Conversation-level export (#6467 PR3).
 *
 * Source boundary: the caller passes the **visible transcript**
 * (`visibleMessages`) — the same messages the chat renders. Internal entries
 * (`contextSummary`, reasoning, tool arguments/results, attachment payloads)
 * never reach this module; `kind === "contextSummary"` is additionally skipped
 * here as defense in depth.
 *
 * Rendering rules (V1):
 * - Markdown export keeps every message's content **verbatim** — fenced
 *   ```chart-json / ```html blocks survive byte-identical.
 * - HTML export renders each message through `formatAiInlineMarkdown`, whose
 *   renderer escapes raw HTML, so ```chart-json / ```html fences come out as
 *   escaped code blocks — original HTML is never injected into the report.
 * - The report document carries the same CSP meta as the safe-HTML preview
 *   shell (`AI_HTML_PREVIEW_CSP`): markdown links/images are the one path
 *   where a report could reference remote resources, and the CSP blocks those
 *   fetches in the standalone file.
 */

export type AiConversationExportFormat = "markdown" | "html";

export interface AiConversationExportMessage {
  role: "user" | "assistant";
  content: string;
  /** Hidden system-generated entries; `contextSummary` is never exported. */
  kind?: string;
  /** Marks assistant replies whose generation failed; rendered with a marker. */
  failed?: boolean;
}

export interface AiConversationExportLabels {
  analysisLabel: string;
  userLabel: string;
  assistantLabel: string;
  failedLabel: string;
}

export interface BuildAiConversationExportInput {
  connectionName?: string;
  dateLabel: string;
  messages: AiConversationExportMessage[];
  format: AiConversationExportFormat;
  labels: AiConversationExportLabels;
}

export interface BuildAiConversationExportOutput {
  content: string;
  defaultFileName: string;
}

function exportableMessages(messages: AiConversationExportMessage[]): AiConversationExportMessage[] {
  return messages.filter((msg) => msg.kind !== "contextSummary" && !!msg.content.trim());
}

export function buildAiConversationExport(input: BuildAiConversationExportInput): BuildAiConversationExportOutput | null {
  const messages = exportableMessages(input.messages);
  if (!messages.length) return null;

  const rawName = input.connectionName || "";
  const sanitizedName = sanitizeExportBaseName(rawName) || "ai";
  const displayName = rawName || "AI";
  const extension = input.format === "markdown" ? "md" : "html";
  const title = `${displayName} · ${input.labels.analysisLabel}`;

  const content = input.format === "markdown" ? buildMarkdownReport(title, input.dateLabel, messages, input.labels) : buildHtmlReport(title, input.dateLabel, messages, input.labels);

  return { content, defaultFileName: `${sanitizedName}_${compactLocalTimestamp()}.${extension}` };
}

function buildMarkdownReport(title: string, dateLabel: string, messages: AiConversationExportMessage[], labels: AiConversationExportLabels): string {
  const lines: string[] = [`# ${title}`, dateLabel, ""];
  for (const msg of messages) {
    lines.push(`## ${msg.role === "user" ? labels.userLabel : labels.assistantLabel}`, "");
    if (msg.failed) lines.push(`**${labels.failedLabel}**`, "");
    lines.push(msg.content, "");
  }
  return lines.join("\n");
}

function buildHtmlReport(title: string, dateLabel: string, messages: AiConversationExportMessage[], labels: AiConversationExportLabels): string {
  const escapedTitle = escapeHtml(title);
  const articles = messages
    .map((msg) => {
      const roleLabel = escapeHtml(msg.role === "user" ? labels.userLabel : labels.assistantLabel);
      const body = formatAiInlineMarkdown(msg.content);
      const failedMark = msg.failed ? `\n<p class="failed">${escapeHtml(labels.failedLabel)}</p>` : "";
      return `<article class="${msg.role}">\n<p class="role">${roleLabel}</p>\n<div class="content">\n${body}\n</div>${failedMark}\n</article>`;
    })
    .join("\n");

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${AI_HTML_PREVIEW_CSP}">`,
    `<title>${escapedTitle}</title>`,
    "<style>",
    AI_CONVERSATION_REPORT_CSS,
    "</style>",
    "</head>",
    "<body>",
    `<header><h1>${escapedTitle}</h1><p class="meta">${escapeHtml(dateLabel)}</p></header>`,
    `<main>${articles}</main>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** Static, light-only report styling. The CSP only allows inline `style-src`, so the sheet rides in the document. */
const AI_CONVERSATION_REPORT_CSS = `
body { margin: 0 auto; max-width: 52rem; padding: 2rem 1rem 4rem; color: #1c1917; background: #ffffff; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.6; }
header h1 { margin: 0 0 0.25rem; font-size: 1.25rem; }
header .meta { margin: 0 0 1.5rem; color: #78716c; font-size: 0.85rem; }
article { border: 1px solid #e7e5e4; border-radius: 8px; padding: 0.75rem 1rem; margin: 0 0 1rem; overflow-wrap: break-word; }
article.user { background: #fafaf9; }
article .role { margin: 0 0 0.25rem; color: #78716c; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
article .content > :first-child { margin-top: 0; }
article .content > :last-child { margin-bottom: 0; }
article .failed { margin: 0.75rem 0 0; color: #dc2626; font-size: 0.85rem; font-weight: 600; }
pre { background: #f5f5f4; border: 1px solid #e7e5e4; border-radius: 6px; padding: 0.75rem; overflow: auto; font-size: 0.8rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:not(pre) > code { background: #f5f5f4; border-radius: 4px; padding: 0.1rem 0.3rem; font-size: 0.85em; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; font-size: 0.85rem; }
th, td { border: 1px solid #e7e5e4; padding: 0.35rem 0.5rem; text-align: left; }
.ai-markdown-table-wrap { overflow-x: auto; }
a { color: #2563eb; }
blockquote { margin: 0.5rem 0; padding: 0.25rem 0.75rem; border-left: 3px solid #e7e5e4; color: #57534e; }
`.trim();
