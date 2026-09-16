const REDIS_GLOB_SPECIAL_CHARS = /[\\*?[\]]/g;
const REDIS_GLOB_SPECIAL_CHARS_FUZZY = /[\\*?[\]]/g;

export function escapeRedisGlobText(value: string, fuzzy = false): string {
  return value.replace(fuzzy ? REDIS_GLOB_SPECIAL_CHARS_FUZZY : REDIS_GLOB_SPECIAL_CHARS, "\\$&");
}

export function redisKeySearchPattern(value: string, fuzzy: boolean): string {
  const pattern = value.trim();
  if (!pattern) return "*";
  return fuzzy ? `*${escapeRedisGlobText(pattern, fuzzy)}*` : pattern;
}

type RedisGlobToken = { kind: "literal"; value: number } | { kind: "star" } | { kind: "any" } | { kind: "class"; negate: boolean; chars: Set<number>; ranges: Array<[number, number]> };

const redisPatternEncoder = new TextEncoder();
const REDIS_NON_ASCII = /[\u0080-\uffff]/;

function parseRedisGlobClass(pattern: Uint8Array, start: number): { token: RedisGlobToken; next: number } {
  let index = start + 1;
  let negate = false;
  if (pattern[index] === 94) {
    negate = true;
    index++;
  }
  const chars = new Set<number>();
  const ranges: Array<[number, number]> = [];
  while (index < pattern.length) {
    if (pattern[index] === 93) {
      return { token: { kind: "class", negate, chars, ranges }, next: index + 1 };
    }
    const value = pattern[index]!;
    if (value === 92 && index + 1 < pattern.length) {
      chars.add(pattern[index + 1]!);
      index += 2;
    } else if (index + 2 < pattern.length && pattern[index + 1] === 45) {
      const startByte = (value << 24) >> 24;
      const endByte = (pattern[index + 2]! << 24) >> 24;
      ranges.push([Math.min(startByte, endByte), Math.max(startByte, endByte)]);
      index += 3;
    } else {
      chars.add(value);
      index++;
    }
  }
  return { token: { kind: "class", negate, chars, ranges }, next: index };
}

function redisGlobTokens(patternText: string): RedisGlobToken[] {
  const pattern = redisPatternEncoder.encode(patternText);
  const tokens: RedisGlobToken[] = [];
  for (let index = 0; index < pattern.length; index++) {
    const value = pattern[index]!;
    if (value === 92 && index + 1 < pattern.length) {
      tokens.push({ kind: "literal", value: pattern[++index]! });
    } else if (value === 42) {
      if (tokens[tokens.length - 1]?.kind !== "star") tokens.push({ kind: "star" });
    } else if (value === 63) {
      tokens.push({ kind: "any" });
    } else if (value === 91) {
      const parsed = parseRedisGlobClass(pattern, index);
      tokens.push(parsed.token);
      index = parsed.next - 1;
    } else {
      tokens.push({ kind: "literal", value });
    }
  }
  return tokens;
}

function redisGlobClassMatches(token: Extract<RedisGlobToken, { kind: "class" }>, value: number): boolean {
  const signedValue = (value << 24) >> 24;
  const matches = token.chars.has(value) || token.ranges.some(([start, end]) => start <= signedValue && signedValue <= end);
  return token.negate ? !matches : matches;
}

export function createRedisKeyPatternMatcher(pattern: string): (value: string, keyRaw?: string) => boolean {
  const tokens = redisGlobTokens(pattern);
  return (value, keyRaw) => {
    let bytes: string | Uint8Array;
    if (keyRaw && value.includes("\\")) {
      try {
        bytes = atob(keyRaw);
      } catch {
        return false;
      }
    } else {
      bytes = REDIS_NON_ASCII.test(value) ? redisPatternEncoder.encode(value) : value;
    }
    let valueIndex = 0;
    let tokenIndex = 0;
    let starTokenIndex = -1;
    let starValueIndex = -1;

    while (valueIndex < bytes.length) {
      const token = tokens[tokenIndex];
      const byte = typeof bytes === "string" ? bytes.charCodeAt(valueIndex) : bytes[valueIndex]!;
      const matches = token?.kind === "literal" ? token.value === byte : token?.kind === "any" ? true : token?.kind === "class" ? redisGlobClassMatches(token, byte) : false;
      if (matches) {
        tokenIndex++;
        valueIndex++;
      } else if (token?.kind === "star") {
        starTokenIndex = tokenIndex++;
        starValueIndex = valueIndex;
      } else if (starTokenIndex >= 0) {
        tokenIndex = starTokenIndex + 1;
        valueIndex = ++starValueIndex;
      } else {
        return false;
      }
    }

    while (tokens[tokenIndex]?.kind === "star") tokenIndex++;
    return tokenIndex === tokens.length;
  };
}

export function redisKeyMatchesPattern(value: string, pattern: string): boolean {
  return createRedisKeyPatternMatcher(pattern)(value);
}

/**
 * SCAN MATCH pattern covering exactly the subtree of a tree group: every
 * segment is glob-escaped so keys containing `*`/`?`/`[`/`]` match literally,
 * and the trailing `*` only widens to the group's descendants.
 */
export function redisGroupSubtreePattern(pathSegments: readonly string[], separator = ":"): string {
  const prefix = pathSegments.map((segment) => escapeRedisGlobText(segment)).join(separator);
  return `${prefix}${separator}*`;
}

// Fuzzy key search has to walk the Redis keyspace because MATCH has no index.
// Start conservatively, then use DBSIZE to cover ordinary databases while
// retaining a hard upper bound for unusually large instances.
export const REDIS_KEY_SEARCH_SCAN_COUNT_BUDGET = 50_000;
export const REDIS_FUZZY_SEARCH_SCAN_COUNT_MAX = 1_000_000;

export function redisFuzzySearchScanBudget(totalKeys: number): number {
  const normalizedTotalKeys = Number.isFinite(totalKeys) ? Math.max(0, Math.floor(totalKeys)) : 0;
  return Math.min(Math.max(REDIS_KEY_SEARCH_SCAN_COUNT_BUDGET, normalizedTotalKeys), REDIS_FUZZY_SEARCH_SCAN_COUNT_MAX);
}

// Redis scan page size (COUNT parameter per SCAN round-trip) — shared defaults
// and validation bounds used by the connection form and key browser.
export const REDIS_SCAN_PAGE_SIZE_DEFAULT = 1000;
export const REDIS_SCAN_PAGE_SIZE_MIN = 200;
export const REDIS_SCAN_PAGE_SIZE_MAX = 10_000;
export const REDIS_SCAN_PAGE_SIZE_OPTIONS = [200, 1000, 2000, 5000, 10_000] as const;
