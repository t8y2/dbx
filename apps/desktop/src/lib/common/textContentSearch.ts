/** Shared in-content find helpers for read-only text surfaces. */
export const TEXT_CONTENT_SEARCH_MATCH_LIMIT = 1000;
export const TEXT_CONTENT_SEARCH_FULL_HIGHLIGHT_MAX_CHARS = 256_000;

export interface TextContentMatch {
  start: number;
  end: number;
}

export interface TextContentSearchRenderOptions {
  activeMatchIndex?: number;
  matchClass?: string;
  activeClass?: string;
  matchAttribute?: (index: number) => string;
  activeAttribute?: (index: number) => string;
}

export function findTextContentMatches(text: string, query: string, limit = TEXT_CONTENT_SEARCH_MATCH_LIMIT): TextContentMatch[] {
  if (!query || limit <= 0) return [];
  // Match the original UTF-16 text so Unicode case folding keeps offsets valid.
  const pattern = new RegExp(escapeRegExp(query), "giu");
  const matches: TextContentMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
}

export function textContentSearchStatus(activeIndex: number, matchCount: number, limited = false): string {
  if (matchCount <= 0) return "0/0";
  return `${activeIndex + 1}/${limited ? `${matchCount}+` : matchCount}`;
}

export function nextTextContentSearchMatchIndex(current: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

export function canFullHighlightTextContent(textLength: number): boolean {
  return textLength <= TEXT_CONTENT_SEARCH_FULL_HIGHLIGHT_MAX_CHARS;
}

export function renderTextContentMatchesHtml(text: string, matches: readonly TextContentMatch[], options: TextContentSearchRenderOptions = {}): string {
  if (matches.length === 0) return escapeTextContentHtml(text);

  const activeMatchIndex = options.activeMatchIndex ?? -1;
  const matchClass = options.matchClass ?? "document-search-match";
  const activeClass = options.activeClass ?? "document-search-match-active";
  const matchAttribute = options.matchAttribute ?? ((index) => `data-document-search-match="${index}"`);
  const activeAttribute = options.activeAttribute ?? (() => 'data-document-search-active="true"');
  let html = "";
  let cursor = 0;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match.start > cursor) html += escapeTextContentHtml(text.slice(cursor, match.start));
    const active = index === activeMatchIndex;
    const className = active ? `${matchClass} ${activeClass}` : matchClass;
    const attributes = `${matchAttribute(index)}${active ? ` ${activeAttribute(index)}` : ""}`;
    html += `<mark class="${className}" ${attributes}>${escapeTextContentHtml(text.slice(match.start, match.end))}</mark>`;
    cursor = match.end;
  }
  if (cursor < text.length) html += escapeTextContentHtml(text.slice(cursor));
  return html;
}

export function renderTextContentSearchHtml(text: string, query: string, activeMatchIndex = 0, limit = TEXT_CONTENT_SEARCH_MATCH_LIMIT): string {
  if (!query || !canFullHighlightTextContent(text.length)) return escapeTextContentHtml(text);
  return renderTextContentMatchesHtml(text, findTextContentMatches(text, query, limit), { activeMatchIndex });
}

/** Grip is a <button>; allow it before blocking other interactive controls. */
export function isTextContentSearchDragSource(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  const el = target as { closest?: (selector: string) => unknown };
  if (typeof el.closest !== "function") return false;
  if (el.closest("[data-drag-handle]")) return true;
  if (el.closest("[data-search-drag-chrome]")) return true;
  if (el.closest("input, textarea, select, button, a, [data-no-drag]")) return false;
  return !!el.closest("[data-draggable-search-panel]");
}

export function escapeTextContentHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
