import { findJsonTreePartMatches } from "../common/jsonTreeSearch";
import { createTextContentSearchPattern, findTextContentMatches, TEXT_CONTENT_SEARCH_MATCH_LIMIT } from "../common/textContentSearch";
import type { RedisContentSearchRequest } from "./redisContentSearchJob";

self.onmessage = ({ data }: MessageEvent<RedisContentSearchRequest>) => {
  try {
    if (data.treeParts !== undefined) {
      self.postMessage({ matches: findJsonTreePartMatches(data.treeParts, data.query, data.options) });
      return;
    }
    if (data.replacement === undefined) {
      self.postMessage({ matches: findTextContentMatches(data.text, data.query, TEXT_CONTENT_SEARCH_MATCH_LIMIT, data.options) });
      return;
    }
    const pattern = createTextContentSearchPattern(data.query, data.options);
    const changes: { from: number; to: number; insert: string }[] = [];
    if (pattern && data.query) {
      for (const match of data.text.matchAll(pattern)) {
        if (!match[0].length) continue;
        if (data.range && (match.index !== data.range.start || match.index + match[0].length !== data.range.end)) continue;
        // Use captures from the original document so lookarounds retain context.
        const insert = data.options.useRegex
          ? data.replacement.replace(/\$(\$|\d+|&)/g, (token, ref: string) => {
              if (ref === "$") return "$";
              if (ref === "&") return match[0];
              const index = Number(ref);
              return index > 0 && index < match.length ? (match[index] ?? "") : token;
            })
          : data.replacement;
        changes.push({ from: match.index, to: match.index + match[0].length, insert });
        if (data.range) break;
      }
    }
    self.postMessage({ matches: [], changes });
  } catch {
    self.postMessage({ matches: [], error: true });
  }
};
