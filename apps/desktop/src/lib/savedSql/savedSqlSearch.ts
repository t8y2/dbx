export interface SavedSqlMatchSegment {
  text: string;
  matched: boolean;
}

export interface SavedSqlLineMatch {
  lineNumber: number;
  column: number;
  lineText: string;
  segments: SavedSqlMatchSegment[];
  contextBefore?: { lineNumber: number; text: string };
  contextAfter?: { lineNumber: number; text: string };
}

export interface SavedSqlSearchMatchResult {
  matches: SavedSqlLineMatch[];
  totalMatches: number;
}

export interface FindSavedSqlSearchMatchesOptions {
  maxMatches?: number;
  maxLineLength?: number;
}

/**
 * Splits text into matched and unmatched segments based on case-insensitive query matching.
 * Preserves the original character casing from the input text.
 */
export function splitSearchMatchSegments(text: string, query: string): SavedSqlMatchSegment[] {
  if (!text || !query) return text ? [{ text, matched: false }] : [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const segments: SavedSqlMatchSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, cursor);
    if (matchIndex < 0) {
      segments.push({ text: text.slice(cursor), matched: false });
      break;
    }
    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), matched: false });
    }
    segments.push({
      text: text.slice(matchIndex, matchIndex + query.length),
      matched: true,
    });
    cursor = matchIndex + query.length;
  }
  return segments;
}

/**
 * Truncates a line around the first match occurrence if it exceeds maxLineLength,
 * prepending/appending ellipsis when truncated.
 */
export function formatSnippetLine(line: string, query: string, maxLineLength = 100): string {
  const trimmed = line.trim();
  if (trimmed.length <= maxLineLength) return trimmed;

  const lowerTrimmed = trimmed.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerTrimmed.indexOf(lowerQuery);
  if (matchIndex < 0) {
    return `${trimmed.slice(0, maxLineLength)}...`;
  }

  // Keep some context characters before and after the match
  const leadContext = 20;
  if (matchIndex <= leadContext + 5) {
    return `${trimmed.slice(0, maxLineLength)}...`;
  }

  const start = Math.max(0, matchIndex - leadContext);
  const end = Math.min(trimmed.length, start + maxLineLength);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < trimmed.length ? "..." : "";
  return `${prefix}${trimmed.slice(start, end)}${suffix}`;
}

/**
 * Searches SQL text for lines matching the query, returning snippets and context lines.
 */
export function findSavedSqlSearchMatches(sql: string, query: string, options: FindSavedSqlSearchMatchesOptions = {}): SavedSqlSearchMatchResult {
  const trimmedQuery = query.trim();
  if (!sql || !trimmedQuery) {
    return { matches: [], totalMatches: 0 };
  }

  const maxMatches = options.maxMatches ?? 3;
  const maxLineLength = options.maxLineLength ?? 100;
  const lines = sql.split(/\r?\n/);
  const lowerQuery = trimmedQuery.toLowerCase();
  const matches: SavedSqlLineMatch[] = [];
  let totalMatches = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lowerLine = rawLine.toLowerCase();
    const matchCol = lowerLine.indexOf(lowerQuery);
    if (matchCol >= 0) {
      totalMatches++;
      if (matches.length < maxMatches) {
        const snippetText = formatSnippetLine(rawLine, trimmedQuery, maxLineLength);
        const segments = splitSearchMatchSegments(snippetText, trimmedQuery);

        const contextBefore = i > 0 && lines[i - 1].trim() ? { lineNumber: i, text: lines[i - 1].trim() } : undefined;
        const contextAfter = i < lines.length - 1 && lines[i + 1].trim() ? { lineNumber: i + 2, text: lines[i + 1].trim() } : undefined;

        matches.push({
          lineNumber: i + 1,
          column: matchCol + 1,
          lineText: snippetText,
          segments,
          contextBefore,
          contextAfter,
        });
      }
    }
  }

  return { matches, totalMatches };
}

/**
 * Formats a 3-line code context snippet for hover tooltips.
 */
export function formatMatchTooltip(match: SavedSqlLineMatch): string {
  const parts: string[] = [];
  if (match.contextBefore) {
    parts.push(`${match.contextBefore.lineNumber} | ${match.contextBefore.text}`);
  }
  parts.push(`${match.lineNumber} | ${match.lineText}`);
  if (match.contextAfter) {
    parts.push(`${match.contextAfter.lineNumber} | ${match.contextAfter.text}`);
  }
  return parts.join("\n");
}
