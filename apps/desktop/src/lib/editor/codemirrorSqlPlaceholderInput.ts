import { readSqlBracedParameterAt, type SqlParameterOptions } from "@/lib/sql/sqlParameters";

// The Lezer Input contract, kept structural to avoid importing a transitive dependency.
interface ParserInput {
  readonly length: number;
  readonly lineChunks: boolean;
  chunk(from: number): string;
  read(from: number, to: number): string;
}

const CHUNK_SIZE = 4096;
const NAME_CHARACTER = /^[\p{L}\p{N}_.]$/u;
const INVALID_BODY_CHARACTER = /[^\p{L}\p{N}_.\s]/u;

/**
 * Give the SQL parser inert, same-length atoms for DBX's MyBatis placeholders.
 * This only changes parser input, never the editor document or executed SQL.
 * Read/cache bounded chunks on demand so an incremental parse near the end of
 * a large script does not flatten or scan its entire unchanged prefix.
 */
export function sqlPlaceholderParserInput(input: ParserInput, options?: SqlParameterOptions): ParserInput {
  const chunks = new Map<number, string>();
  const whitespaceStarts = new Map<number, number>();
  const nameStarts = new Map<number, number>();
  const placeholderEnds = new Map<number, number | undefined>();

  function previousCharacter(position: number): string {
    const characters = Array.from(input.read(Math.max(0, position - 2), position));
    return characters[characters.length - 1] ?? "";
  }

  function skipBack(position: number, characterPattern: RegExp, cache: Map<number, number>): number {
    let start = position;
    while (start > 0) {
      const cached = cache.get(start);
      if (cached !== undefined) {
        start = cached;
        break;
      }
      const character = previousCharacter(start);
      if (!characterPattern.test(character)) break;
      start -= character.length;
    }
    // Reuse runs at earlier chunk boundaries rather than rescanning a long
    // whitespace/identifier prefix for every chunk of a full parse.
    cache.set(position, start);
    return start;
  }

  function containingPlaceholderStart(position: number): number {
    // A UTF-16 chunk boundary may bisect an astral name character. Include
    // its low surrogate before walking backward over complete code points.
    const boundary = input.read(Math.max(0, position - 1), Math.min(input.length, position + 1));
    let start = boundary.length === 2 && NAME_CHARACTER.test(boundary) ? position + 1 : position;
    start = skipBack(start, /\s/u, whitespaceStarts);
    start = skipBack(start, NAME_CHARACTER, nameStarts);
    start = skipBack(start, /\s/u, whitespaceStarts);
    if (input.read(Math.max(0, start - 2), start) === "#{") return start - 2;
    if (input.read(Math.max(0, start - 1), start + 1) === "#{") return start - 1;
    return position;
  }

  function placeholderEnd(start: number): number | undefined {
    if (placeholderEnds.has(start)) return placeholderEnds.get(start);
    const end = scanPlaceholderEnd(start);
    placeholderEnds.set(start, end);
    return end;
  }

  function scanPlaceholderEnd(start: number): number | undefined {
    let body = "#{";
    let position = start + 2;
    while (position < input.length) {
      let to = Math.min(input.length, position + CHUNK_SIZE);
      const last = input.read(to - 1, to).charCodeAt(0);
      if (last >= 0xd800 && last <= 0xdbff && to < input.length) to += 1;
      const part = input.read(position, to);
      const invalid = INVALID_BODY_CHARACTER.exec(part);
      if (invalid) {
        if (invalid[0] !== "}") return undefined;
        body += part.slice(0, invalid.index + 1);
        const parameter = readSqlBracedParameterAt(body, 0, options);
        return parameter ? start + parameter.end : undefined;
      }
      body += part;
      position += part.length;
    }
    return undefined;
  }

  function maskedChunk(block: number): string {
    const cached = chunks.get(block);
    if (cached !== undefined) return cached;
    const from = block * CHUNK_SIZE;
    const to = Math.min(input.length, from + CHUNK_SIZE);
    const source = input.read(from, to);
    let position = containingPlaceholderStart(from);
    let copied = from;
    const parts: string[] = [];
    // One extra character recognizes an opener split across chunk boundaries.
    const search = input.read(position, Math.min(input.length, to + 1));
    const searchFrom = position;
    while (position < to) {
      const offset = search.indexOf("#{", position - searchFrom);
      if (offset === -1) break;
      const start = searchFrom + offset;
      if (start >= to) break;
      const end = placeholderEnd(start);
      if (end !== undefined && end > from) {
        const maskFrom = Math.max(from, start);
        const maskTo = Math.min(to, end);
        parts.push(source.slice(copied - from, maskFrom - from));
        const masked = source.slice(maskFrom - from, maskTo - from).replace(/[^\r\n]/g, " ");
        parts.push(maskFrom === start ? `?${masked.slice(1)}` : masked);
        copied = maskTo;
      }
      position = end ?? start + 2;
    }
    parts.push(source.slice(copied - from));
    const masked = parts.join("");
    chunks.set(block, masked);
    return masked;
  }

  return {
    length: input.length,
    lineChunks: false,
    chunk(from) {
      if (from >= input.length) return "";
      return maskedChunk(Math.floor(from / CHUNK_SIZE)).slice(from % CHUNK_SIZE);
    },
    read(from, to) {
      const parts: string[] = [];
      for (let position = from; position < to; ) {
        const part = this.chunk(position).slice(0, to - position);
        parts.push(part);
        position += part.length;
      }
      return parts.join("");
    },
  };
}
