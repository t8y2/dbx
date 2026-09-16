import { Marked } from "marked";

/** Escape the five characters that can break out of text or an attribute value. */
function escapeHtml(value: unknown): string {
  return (
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // Single quotes too, so the escaper is self-sufficient. Every attribute
      // here is double-quoted today, which makes this redundant — but that is a
      // formatting convention enforced nowhere, and the day someone writes
      // title='...' it becomes the difference between escaping and a breakout.
      .replace(/'/g, "&#39;")
  );
}

/**
 * URL allowlist. Blocklists lose: `javascript:` alone misses `JaVaScRiPt:`,
 * the entity-encoded `&#106;avascript:`, `vbscript:` and `data:text/html`.
 * Permitting only what we understand is both shorter and complete.
 */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

function safeUrl(raw: unknown): string | null {
  const url = String(raw ?? "").trim();
  if (url === "") {
    return null;
  }
  // Protocol-relative. Harmless over https, but the Part 3b standalone export
  // is opened via file://, where //host/path is a UNC path — on Windows that
  // opens an SMB connection and leaks an NTLM hash, and images need no click.
  // Both separators must be rejected: the URL spec treats /\ exactly like //.
  if (/^[/\\]{2}/.test(url)) {
    return null;
  }
  if (url.startsWith("#") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return url;
  }
  return SAFE_SCHEME.test(url) ? url : null;
}

const renderer = new Marked({
  renderer: {
    // Raw HTML in the source is shown as text, never rendered.
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      // `tokens`, not `text` — `text` is the raw markdown source, so returning
      // it would emit author HTML unescaped and swallow inline formatting.
      const inner = this.parser.parseInline(tokens);
      const safe = safeUrl(href);
      if (safe === null) {
        return inner;
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${titleAttr}>${inner}</a>`;
    },
    image({ href, title, text }) {
      const safe = safeUrl(href);
      if (safe === null) {
        return escapeHtml(text);
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}"${titleAttr}>`;
    },
  },
});

/** Render a note's markdown to HTML with all author-supplied HTML escaped. */
export function renderNote(markdown: string | null): string {
  if (markdown === null || markdown.trim() === "") {
    return "";
  }
  return renderer.parse(markdown) as string;
}
