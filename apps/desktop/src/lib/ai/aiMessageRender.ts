export interface AiMessageTextSegment {
  type: "text";
  content: string;
  html: string;
}

export interface AiMessageCodeSegment {
  type: "code";
  content: string;
  lang: string;
  html: string;
  isSql: boolean;
  /** True while the fence is still open, i.e. the code is only partially streamed. */
  pending: boolean;
}

export type AiMessageRenderSegment = AiMessageTextSegment | AiMessageCodeSegment;

interface MessageSegment {
  type: "text" | "code";
  content: string;
  lang?: string;
  /** Code segments only: whether the closing fence has arrived. */
  closed?: boolean;
}

export interface AiMessageRenderOptions {
  /** Set while the message is still streaming: the trailing segment keeps growing. */
  streaming?: boolean;
}

export interface AiMessageRendererOptions {
  maxEntries?: number;
  maxCacheableChars?: number;
  maxSegmentEntries?: number;
  markdown: (text: string) => string;
  highlightCode?: (content: string, lang: string) => string;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_CACHEABLE_CHARS = 20_000;
const DEFAULT_MAX_SEGMENT_ENTRIES = 300;
const SQL_LANGUAGES = new Map([
  ["sql", "SQL"],
  ["mysql", "MYSQL"],
  ["postgres", "POSTGRESQL"],
  ["postgresql", "POSTGRESQL"],
  ["sqlite", "SQLITE"],
  ["tsql", "TSQL"],
  ["clickhouse", "CLICKHOUSE"],
  ["mongodb", "MONGODB"],
  ["mongo", "MONGODB"],
]);
const SHELL_LANGUAGES = new Map([
  ["bash", "BASH"],
  ["sh", "SHELL"],
  ["shell", "SHELL"],
  ["zsh", "ZSH"],
]);
const SQL_LANGUAGE_LABELS = new Set(SQL_LANGUAGES.values());

export function createAiMessageRenderer(options: AiMessageRendererOptions) {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxCacheableChars = Math.max(0, Math.floor(options.maxCacheableChars ?? DEFAULT_MAX_CACHEABLE_CHARS));
  const maxSegmentEntries = Math.max(1, Math.floor(options.maxSegmentEntries ?? DEFAULT_MAX_SEGMENT_ENTRIES));
  const cache = new Map<string, AiMessageRenderSegment[]>();
  const segmentCache = new Map<string, AiMessageRenderSegment>();

  function renderSegment(segment: MessageSegment, pending: boolean): AiMessageRenderSegment {
    if (segment.type === "text") {
      return { type: "text", content: segment.content, html: options.markdown(segment.content) };
    }
    const lang = normalizeAiCodeLanguage(segment.lang);
    return {
      type: "code",
      content: segment.content,
      // Highlighting a half-streamed block is wasted work: it is re-highlighted once the fence closes.
      html: (pending ? undefined : options.highlightCode?.(segment.content, lang)) ?? escapeHtml(segment.content),
      lang,
      isSql: isSqlAiCodeLanguage(lang),
      pending,
    };
  }

  function renderCachedSegment(segment: MessageSegment, pending: boolean): AiMessageRenderSegment {
    if (segment.content.length > maxCacheableChars) return renderSegment(segment, pending);

    const key = `${segment.type}\u0000${segment.lang ?? ""}\u0000${pending ? "1" : "0"}\u0000${segment.content}`;
    const cached = segmentCache.get(key);
    if (cached) {
      segmentCache.delete(key);
      segmentCache.set(key, cached);
      return cached;
    }

    const rendered = renderSegment(segment, pending);
    segmentCache.set(key, rendered);
    evictOldest(segmentCache, maxSegmentEntries);
    return rendered;
  }

  function render(content: string, renderOptions: AiMessageRenderOptions = {}): AiMessageRenderSegment[] {
    const streaming = renderOptions.streaming === true;
    const cacheable = !streaming && content.length <= maxCacheableChars;
    const cached = cacheable ? cache.get(content) : undefined;
    if (cached) {
      cache.delete(content);
      cache.set(content, cached);
      return cached;
    }

    const segments = parseAiMessage(content);
    const lastIndex = segments.length - 1;
    const rendered = segments.map((segment, index): AiMessageRenderSegment => {
      const isTail = streaming && index === lastIndex;
      const pending = isTail && segment.type === "code" && segment.closed !== true;
      // The tail keeps growing, so caching it would only fill the cache with dead intermediate versions.
      // Everything before it is final and is reused as-is across frames, which keeps the DOM patch minimal.
      return isTail ? renderSegment(segment, pending) : renderCachedSegment(segment, false);
    });

    if (cacheable) {
      cache.set(content, rendered);
      evictOldest(cache, maxEntries);
    }
    return rendered;
  }

  function clear() {
    cache.clear();
    segmentCache.clear();
  }

  return { render, clear };
}

function evictOldest(target: Map<string, unknown>, maxEntries: number) {
  while (target.size > maxEntries) {
    const oldestKey = target.keys().next().value;
    if (oldestKey === undefined) break;
    target.delete(oldestKey);
  }
}

export function parseAiMessage(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const fenceMatch = lines[i].match(/^```([a-zA-Z0-9_+.-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "sql";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      const closed = i < lines.length;
      if (closed) i++;
      const content = codeLines.join("\n").trim();
      if (content) segments.push({ type: "code", lang, content, closed });
    } else {
      const textLines: string[] = [];
      while (i < lines.length && !/^```([a-zA-Z0-9_+.-]*)\s*$/.test(lines[i])) {
        textLines.push(lines[i]);
        i++;
      }
      const content = textLines.join("\n");
      if (content.trim()) segments.push({ type: "text", content });
    }
  }

  return segments;
}

export function normalizeAiCodeLanguage(lang?: string): string {
  const key = (lang || "sql").trim().toLowerCase();
  if (!key) return "SQL";
  return SQL_LANGUAGES.get(key) || SHELL_LANGUAGES.get(key) || (key === "json" ? "JSON" : key.toUpperCase());
}

export function isSqlAiCodeLanguage(lang: string): boolean {
  return SQL_LANGUAGE_LABELS.has(lang);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
