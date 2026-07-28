/** Match helpers for Redis STRING value Ctrl+F (in-content find only). */

export const REDIS_VALUE_SEARCH_MATCH_LIMIT = 1000;
export const REDIS_VALUE_SEARCH_FULL_HIGHLIGHT_MAX_CHARS = 256_000;

export interface RedisTextMatch {
  start: number;
  end: number;
}

export function findRedisTextMatches(text: string, query: string, limit = REDIS_VALUE_SEARCH_MATCH_LIMIT): RedisTextMatch[] {
  if (!query || limit <= 0) return [];
  // Match against the original UTF-16 text so Unicode case folding cannot
  // change string length and corrupt the offsets used for highlighting.
  const pattern = new RegExp(escapeRegExp(query), "giu");
  const matches: RedisTextMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    matches.push({ start, end: start + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
}

export function redisValueSearchStatus(activeIndex: number, matchCount: number, limited = false): string {
  if (matchCount <= 0) return "0/0";
  return `${activeIndex + 1}/${limited ? `${matchCount}+` : matchCount}`;
}

export function nextRedisSearchMatchIndex(current: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

export function canFullHighlightRedisText(textLength: number): boolean {
  return textLength <= REDIS_VALUE_SEARCH_FULL_HIGHLIGHT_MAX_CHARS;
}

export function renderRedisTextSearchHtml(text: string, query: string, activeMatchIndex = 0, limit = REDIS_VALUE_SEARCH_MATCH_LIMIT): string {
  if (!query || !canFullHighlightRedisText(text.length)) return escapeHtml(text);
  const matches = findRedisTextMatches(text, query, limit);
  if (matches.length === 0) return escapeHtml(text);
  let html = "";
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match.start > cursor) html += escapeHtml(text.slice(cursor, match.start));
    const activeClass = index === activeMatchIndex ? " document-search-match-active" : "";
    const activeAttribute = index === activeMatchIndex ? ' data-document-search-active="true"' : "";
    html += `<mark class="document-search-match${activeClass}" data-document-search-match="${index}"${activeAttribute}>${escapeHtml(text.slice(match.start, match.end))}</mark>`;
    cursor = match.end;
  }
  if (cursor < text.length) html += escapeHtml(text.slice(cursor));
  return html;
}

/** Grip is a <button>; allow it before blocking other buttons. */
export function isTextContentSearchDragSource(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  const el = target as { closest?: (selector: string) => unknown };
  if (typeof el.closest !== "function") return false;
  if (el.closest("[data-drag-handle]")) return true;
  if (el.closest("[data-search-drag-chrome]")) return true;
  if (el.closest("input, textarea, select, button, a, [data-no-drag]")) return false;
  return !!el.closest("[data-draggable-search-panel]");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
