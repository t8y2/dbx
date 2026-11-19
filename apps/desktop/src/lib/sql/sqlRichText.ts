/**
 * Rich-text (HTML) rendering for SQL, used when copying code out of the editor
 * into rich-text targets such as email clients, Word, or chat apps.
 *
 * Email clients strip `<style>` blocks and `class` attributes, so every token
 * color is emitted as an inline `style` attribute and the whole snippet lives
 * in a single `<pre>` that carries its own inline layout. Nothing here depends
 * on a stylesheet surviving the paste.
 *
 * The light theme is forced regardless of the app appearance: some clients
 * (Outlook's Word-based renderer in particular) drop `background-color`, and
 * dark text on a white mail body stays readable where light-on-dark would not.
 */
import { copyRichTextToClipboard } from "@/lib/common/clipboard";
import { escapeHtml, getShikiSqlHighlighter, type ShikiHighlighter } from "@/lib/sql/sqlHighlighter";

const SQL_LANG = "sql";
const RICH_TEXT_THEME = "github-light";

const FOREGROUND = "#24292e";
const BACKGROUND = "#ffffff";
const BORDER = "#d0d7de";
const FONT_STACK = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** Shiki `FontStyle` bitmask values. */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

/**
 * Above this size we skip tokenizing and emit uncolored markup. Copying a
 * multi-hundred-kilobyte query should still work, just without highlighting.
 */
const MAX_HIGHLIGHTED_LENGTH = 200_000;

interface RichTextToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

type ShikiTokenHighlighter = Pick<ShikiHighlighter, "codeToTokensBase">;

/**
 * Render SQL as a self-contained, paste-friendly HTML fragment.
 *
 * Never throws: if Shiki cannot load or cannot parse the input, the result is
 * the escaped source in the same `<pre>` shell, so the copy degrades to
 * uncolored monospace instead of failing.
 */
export async function renderSqlRichTextHtml(code: string): Promise<string> {
  if (code.length > MAX_HIGHLIGHTED_LENGTH) {
    return wrapInPre(escapeHtml(code));
  }

  try {
    const highlighter: ShikiTokenHighlighter = await getShikiSqlHighlighter();
    const lines = highlighter.codeToTokensBase(code, { lang: SQL_LANG, theme: RICH_TEXT_THEME });
    const body = lines.map((line) => line.map(tokenToHtml).join("")).join("\n");
    return wrapInPre(body);
  } catch (error) {
    console.warn("[DBX][sqlRichText] Failed to highlight SQL, falling back to plain markup:", error);
    return wrapInPre(escapeHtml(code));
  }
}

/**
 * Copy SQL to the clipboard as both HTML and plain text.
 *
 * Rich-text targets get the highlighted snippet; plain-text targets (a terminal,
 * another SQL editor) get the original `code` unchanged.
 */
export async function copySqlAsRichText(code: string): Promise<void> {
  const html = await renderSqlRichTextHtml(code);
  await copyRichTextToClipboard(html, code);
}

function tokenToHtml(token: RichTextToken): string {
  const style = tokenStyle(token);
  const escaped = escapeHtml(token.content);
  return style ? `<span style="${style}">${escaped}</span>` : escaped;
}

function tokenStyle(token: RichTextToken): string {
  const parts: string[] = [];
  if (token.color) parts.push(`color:${token.color}`);

  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & FONT_STYLE_ITALIC) parts.push("font-style:italic");
  if (fontStyle & FONT_STYLE_BOLD) parts.push("font-weight:bold");
  if (fontStyle & FONT_STYLE_UNDERLINE) parts.push("text-decoration:underline");

  return parts.join(";");
}

function wrapInPre(innerHtml: string): string {
  const style = [`font-family:${FONT_STACK}`, "font-size:13px", "line-height:1.55", `color:${FOREGROUND}`, `background-color:${BACKGROUND}`, `border:1px solid ${BORDER}`, "border-radius:6px", "padding:12px 14px", "margin:0", "white-space:pre", "overflow-x:auto"].join(";");

  return `<pre style="${style}">${innerHtml}</pre>`;
}
