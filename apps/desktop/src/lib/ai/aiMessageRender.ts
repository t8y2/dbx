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
  /** True while the closing fence is missing, i.e. the code is incomplete and must not be executed. */
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
  maxCacheChars?: number;
  markdown: (text: string) => string;
  highlightCode?: (content: string, lang: string) => string;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_CACHEABLE_CHARS = 20_000;
const DEFAULT_MAX_SEGMENT_ENTRIES = 300;
const DEFAULT_MAX_CACHE_CHARS = 400_000;
/** Streaming text is flushed into a cached block only once it is long enough to be worth a cache entry. */
const STREAM_BLOCK_MIN_CHARS = 240;
const BLANK_LINE_RE = /\n{2,}/g;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// Definitions inside block containers still apply to the whole document. Container indentation
// may exceed three columns, so this prefix is intentionally conservative: a false positive only
// disables streaming splits, while a false negative changes reference-link rendering.
const LINK_REFERENCE_RE = /^(?:[ \t]*(?:>[ \t]?|(?:[*+-]|\d{1,9}[.)])[ \t]+))*[ \t]*\[(?:\\.|[^\]\\]){1,999}\]:/m;
// Raw HTML blocks stay open across blank lines, which no block boundary may cut:
// comments, processing instructions, declarations, CDATA and the raw-text elements.
const RAW_HTML_BLOCK_RE = /<!--|<\?|<!\[CDATA\[|<![A-Za-z]|<\/?(?:script|style|pre|textarea)\b/i;
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

interface SegmentRenderFlags {
  /** The fence is still open, so the code is incomplete. */
  pending: boolean;
  /** The segment is the growing tail of a streaming message. */
  live: boolean;
}

export function createAiMessageRenderer(options: AiMessageRendererOptions) {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxCacheableChars = Math.max(0, Math.floor(options.maxCacheableChars ?? DEFAULT_MAX_CACHEABLE_CHARS));
  const maxSegmentEntries = Math.max(1, Math.floor(options.maxSegmentEntries ?? DEFAULT_MAX_SEGMENT_ENTRIES));
  // Split the budget so the two caches together stay under the configured character count.
  const maxCacheChars = Math.max(2, Math.floor(options.maxCacheChars ?? DEFAULT_MAX_CACHE_CHARS));
  const cache = createRenderCache<AiMessageRenderSegment[]>(maxEntries, Math.floor(maxCacheChars / 2));
  const segmentCache = createRenderCache<AiMessageRenderSegment>(maxSegmentEntries, Math.floor(maxCacheChars / 2));
  // Bounded by the one answer being streamed, and dropped as soon as another answer starts.
  const streamBlocks = new Map<string, AiMessageRenderSegment>();
  let streamContent = "";

  function renderSegment(segment: MessageSegment, flags: SegmentRenderFlags): AiMessageRenderSegment {
    if (segment.type === "text") {
      return { type: "text", content: segment.content, html: options.markdown(segment.content) };
    }
    const lang = normalizeAiCodeLanguage(segment.lang);
    // Highlighting a block that is still streaming is wasted work: it is re-highlighted once the fence closes.
    const highlighted = flags.live && flags.pending ? undefined : options.highlightCode?.(segment.content, lang);
    return {
      type: "code",
      content: segment.content,
      html: highlighted ?? escapeHtml(segment.content),
      lang,
      isSql: isSqlAiCodeLanguage(lang),
      pending: flags.pending,
    };
  }

  function renderCachedSegment(segment: MessageSegment, flags: SegmentRenderFlags): AiMessageRenderSegment {
    if (segment.content.length > maxCacheableChars) return renderSegment(segment, flags);

    // Length-prefixed so no field separator can be forged by segment content.
    const key = `${segment.type}|${segment.lang ?? ""}|${flags.pending ? 1 : 0}|${segment.content.length}|${segment.content}`;
    const cached = segmentCache.get(key);
    if (cached) return cached;

    const rendered = renderSegment(segment, flags);
    segmentCache.set(key, rendered, segment.content.length + rendered.html.length);
    return rendered;
  }

  /**
   * Blocks of the message being streamed right now. They are held apart from the shared caches:
   * an LRU sized for finished messages would evict them while the same message is still growing.
   */
  function renderStreamingBlock(block: string): AiMessageRenderSegment {
    const cached = streamBlocks.get(block);
    if (cached) return cached;

    const rendered = renderSegment({ type: "text", content: block }, { pending: false, live: false });
    streamBlocks.set(block, rendered);
    return rendered;
  }

  function renderTail(segment: MessageSegment): AiMessageRenderSegment[] {
    const pending = segment.type === "code" && segment.closed !== true;
    // Only the trailing block of a streaming message keeps changing. Blocks before it are final,
    // so they are rendered once and reused by reference, which keeps both parsing and DOM patches small.
    if (segment.type === "text") {
      const blocks = splitStreamingTextBlocks(segment.content);
      const live = blocks[blocks.length - 1];
      return [...blocks.slice(0, -1).map(renderStreamingBlock), renderSegment({ type: "text", content: live }, { pending: false, live: true })];
    }
    return [renderSegment(segment, { pending, live: true })];
  }

  function render(content: string, renderOptions: AiMessageRenderOptions = {}): AiMessageRenderSegment[] {
    const streaming = renderOptions.streaming === true;
    if (streaming) {
      // A content that no longer extends the previous one belongs to another answer.
      if (!content.startsWith(streamContent)) streamBlocks.clear();
      streamContent = content;
    }
    const cacheable = !streaming && content.length <= maxCacheableChars;
    const cached = cacheable ? cache.get(content) : undefined;
    if (cached) return cached;

    const segments = parseAiMessage(content);
    const lastIndex = segments.length - 1;
    const rendered = segments.flatMap((segment, index): AiMessageRenderSegment[] => {
      if (streaming && index === lastIndex) return renderTail(segment);
      const pending = segment.type === "code" && segment.closed !== true;
      return [renderCachedSegment(segment, { pending, live: false })];
    });

    // Charge for the HTML the entry pins, not just for the source text.
    if (cacheable) cache.set(content, rendered, content.length + rendered.reduce((sum, segment) => sum + segment.html.length, 0));
    return rendered;
  }

  function clear() {
    cache.clear();
    segmentCache.clear();
    streamBlocks.clear();
    streamContent = "";
  }

  return { render, clear };
}

/**
 * Splits the streaming tail into stable blocks plus the block that is still growing.
 * Always returns at least one entry; the last one is the live block.
 *
 * Each block is parsed on its own, so a boundary is only taken where Markdown cannot
 * carry state across it. Anything ambiguous stays joined and is simply re-parsed.
 */
export function splitStreamingTextBlocks(content: string): string[] {
  // Link reference definitions apply to the whole document, and raw HTML blocks can span any
  // number of blank lines: neither survives being parsed block by block.
  if (LINK_REFERENCE_RE.test(content) || RAW_HTML_BLOCK_RE.test(content)) return [content];

  const blocks: string[] = [];
  let buffer = "";
  let index = 0;
  let fence: FenceState = null;

  BLANK_LINE_RE.lastIndex = 0;
  for (let match = BLANK_LINE_RE.exec(content); match; match = BLANK_LINE_RE.exec(content)) {
    const nextIndex = match.index + match[0].length;
    const chunk = content.slice(index, nextIndex);
    // Fences that parseAiMessage leaves in the text (`~~~`, longer or annotated backtick
    // runs) may contain blank lines, so a boundary inside one would cut the block open.
    fence = trackFenceState(chunk, fence);
    buffer += chunk;
    index = nextIndex;
    // A blank line only ends a block when what follows starts a new one; list items,
    // indented continuations, and quotes may still belong to the block before them.
    if (!fence && buffer.length >= STREAM_BLOCK_MIN_CHARS && startsNewMarkdownBlock(content.slice(nextIndex))) {
      blocks.push(buffer);
      buffer = "";
    }
  }

  blocks.push(buffer + content.slice(index));
  return blocks;
}

function startsNewMarkdownBlock(rest: string): boolean {
  // An empty rest means the next block has not been streamed yet, so the boundary is not decidable.
  if (!rest) return false;
  const first = rest[0];
  // Whitespace continues the previous block (indented code or a lazy list continuation).
  if (/\s/.test(first)) return false;
  // Block markers that can resume the construct above the blank line.
  if ("-*+>|=~:`[".includes(first)) return false;
  return !/^\d+[.)]/.test(rest);
}

type FenceState = { marker: string; length: number } | null;

function trackFenceState(chunk: string, state: FenceState): FenceState {
  for (const line of chunk.split("\n")) {
    const match = FENCE_LINE_RE.exec(line);
    if (!match) continue;
    const marker = match[1][0];
    const length = match[1].length;
    if (!state) {
      // A backtick info string cannot contain backticks, so such a line is not an opening fence.
      if (marker === "`" && match[2].includes("`")) continue;
      state = { marker, length };
    } else if (marker === state.marker && length >= state.length && !match[2].trim()) {
      state = null;
    }
  }
  return state;
}

interface RenderCacheEntry<T> {
  value: T;
  size: number;
}

function createRenderCache<T>(maxEntries: number, maxChars: number) {
  const entries = new Map<string, RenderCacheEntry<T>>();
  let totalChars = 0;

  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key: string, value: T, size: number) {
      const previous = entries.get(key);
      if (previous) {
        totalChars -= previous.size;
        entries.delete(key);
      }
      // An entry that alone busts the budget is never worth keeping.
      if (size > maxChars) return;
      entries.set(key, { value, size });
      totalChars += size;
      // Bound both the entry count and the retained characters: a few large answers can hold
      // far more memory than many small ones.
      while (entries.size > maxEntries || totalChars > maxChars) {
        const oldest = entries.entries().next().value;
        if (!oldest) break;
        entries.delete(oldest[0]);
        totalChars -= oldest[1].size;
      }
    },
    clear() {
      entries.clear();
      totalChars = 0;
    },
  };
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
