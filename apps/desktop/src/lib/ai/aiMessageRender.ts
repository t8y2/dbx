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
}

export type AiMessageRenderSegment = AiMessageTextSegment | AiMessageCodeSegment;

interface MessageSegment {
  type: "text" | "code";
  content: string;
  lang?: string;
}

export interface AiMessageRendererOptions {
  maxEntries?: number;
  maxCacheableChars?: number;
  markdown: (text: string) => string;
  highlightCode?: (content: string, lang: string) => string;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_CACHEABLE_CHARS = 20_000;
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
  const cache = new Map<string, AiMessageRenderSegment[]>();

  function render(content: string): AiMessageRenderSegment[] {
    const cacheable = content.length <= maxCacheableChars;
    const cached = cacheable ? cache.get(content) : undefined;
    if (cached) {
      cache.delete(content);
      cache.set(content, cached);
      return cached;
    }

    const rendered = parseAiMessage(content).map((segment): AiMessageRenderSegment => {
      if (segment.type === "text") {
        return { type: "text", content: segment.content, html: options.markdown(segment.content) };
      }
      const lang = normalizeAiCodeLanguage(segment.lang);
      return {
        type: "code",
        content: segment.content,
        html: options.highlightCode?.(segment.content, lang) ?? escapeHtml(segment.content),
        lang,
        isSql: isSqlAiCodeLanguage(lang),
      };
    });

    if (cacheable) {
      cache.set(content, rendered);
      while (cache.size > maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
      }
    }
    return rendered;
  }

  function clear() {
    cache.clear();
  }

  return { render, clear };
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
      if (i < lines.length) i++;
      const content = codeLines.join("\n").trim();
      if (content) segments.push({ type: "code", lang, content });
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
