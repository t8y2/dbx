export interface AiTableMention {
  raw: string;
  schema?: string;
  table: string;
}

export const AI_TABLE_MENTION_SCHEMA_LIMIT = 8;
export const AI_TABLE_MENTION_CANDIDATE_LIMIT = 200;

const SIMPLE_IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

function isMentionBoundary(char: string | undefined): boolean {
  return !char || /\s|[([{,;:]/.test(char);
}

function isUnquotedMentionChar(char: string): boolean {
  return /[\p{L}\p{N}_$.-]/u.test(char);
}

function readQuotedSegment(source: string, start: number): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "`") return null;
  let value = "";
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === quote) {
      if (source[i + 1] === quote) {
        value += quote;
        i++;
        continue;
      }
      return { value, end: i + 1 };
    }
    value += char;
  }
  return null;
}

function readMentionToken(source: string, start: number): { raw: string; parts: string[]; end: number } | null {
  let i = start;
  const parts: string[] = [];
  let raw = "";

  while (i < source.length) {
    const quoted = readQuotedSegment(source, i);
    if (quoted) {
      parts.push(quoted.value);
      raw += source.slice(i, quoted.end);
      i = quoted.end;
    } else {
      let value = "";
      const valueStart = i;
      while (i < source.length && isUnquotedMentionChar(source[i]) && source[i] !== ".") {
        value += source[i];
        i++;
      }
      if (!value) break;
      parts.push(value);
      raw += source.slice(valueStart, i);
    }

    if (source[i] !== ".") break;
    raw += ".";
    i++;
  }

  const usableParts = parts.filter(Boolean);
  if (!usableParts.length) return null;
  return { raw, parts: usableParts, end: i };
}

export function parseAiTableMentions(text: string): AiTableMention[] {
  const mentions: AiTableMention[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || !isMentionBoundary(text[i - 1])) continue;
    const token = readMentionToken(text, i + 1);
    if (!token) continue;

    const table = token.parts[token.parts.length - 1];
    const schema = token.parts.length > 1 ? token.parts[token.parts.length - 2] : undefined;
    const key = `${schema || ""}.${table}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push({ raw: `@${token.raw}`, schema, table });
    }
    i = token.end - 1;
  }

  return mentions;
}

export function formatAiTableMention(schema: string | undefined, table: string): string {
  const parts = [schema, table].filter((part): part is string => !!part);
  return `@${parts.map(formatMentionPart).join(".")}`;
}

function formatMentionPart(part: string): string {
  if (SIMPLE_IDENTIFIER_RE.test(part)) return part;
  return `"${part.replace(/"/g, '""')}"`;
}

export function aiTableMentionKey(schema: string | undefined, table: string): string {
  return `${schema || ""}.${table}`.toLowerCase();
}

export function filterAiTableMentionCandidates<T extends { name: string }>(candidates: T[], tableFilter: string, limit = AI_TABLE_MENTION_CANDIDATE_LIMIT): T[] {
  const normalizedFilter = tableFilter.toLowerCase();
  return candidates.filter((candidate) => !normalizedFilter || candidate.name.toLowerCase().includes(normalizedFilter)).slice(0, limit);
}
