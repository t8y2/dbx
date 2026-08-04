import { pinyin } from "pinyin-pro";

const HAN_CHAR = /\p{Script=Han}/u;
const ASCII_ALNUM = /[a-z0-9]/i;

const firstLetterCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 100_000;

function cacheFirstLetters(text: string, result: string): void {
  if (firstLetterCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = firstLetterCache.keys().next().value;
    if (oldest !== undefined) firstLetterCache.delete(oldest);
  }
  firstLetterCache.set(text, result);
}

export function containsHan(text: string): boolean {
  return HAN_CHAR.test(text);
}

/**
 * First pinyin letter of every Han character, with ASCII letters/digits kept
 * as-is (lowercased) and every other character dropped. Used for DataGrip-style
 * initials matching, e.g. pinyinFirstLetters("总租金") === "zzj".
 *
 * Only the default reading is used for polyphonic characters.
 */
export function pinyinFirstLetters(text: string): string {
  const cached = firstLetterCache.get(text);
  if (cached !== undefined) {
    firstLetterCache.delete(text);
    firstLetterCache.set(text, cached);
    return cached;
  }
  let result = "";
  for (const char of text) {
    if (HAN_CHAR.test(char)) {
      result += pinyin(char, { pattern: "first", toneType: "none" });
    } else if (ASCII_ALNUM.test(char)) {
      result += char.toLowerCase();
    }
  }
  cacheFirstLetters(text, result);
  return result;
}

/** True when an ASCII-letters/digits query can match `candidate` via pinyin initials. */
export function matchesPinyinInitials(candidate: string, query: string): boolean {
  if (!/^[a-z0-9]+$/.test(query) || !containsHan(candidate)) return false;
  return pinyinFirstLetters(candidate).startsWith(query);
}

/**
 * Ordered-subsequence match of `query` against `text` (e.g. "zj" against the
 * initials "zzj"). Returns the first matched index and the span covering all
 * matched characters, or null when the query is not a subsequence.
 */
export function orderedSubsequenceSpan(text: string, query: string): { first: number; span: number } | null {
  if (!query) return null;
  let from = 0;
  let first = -1;
  let last = -1;
  for (const char of query) {
    const position = text.indexOf(char, from);
    if (position < 0) return null;
    if (first < 0) first = position;
    last = position;
    from = position + 1;
  }
  return { first, span: last - first + 1 };
}

/**
 * Generic matcher for small pick-lists (grid condition editor, ...):
 * prefix > pinyin-initials prefix > substring > pinyin-initials subsequence.
 * Returns -1 for no match; scores are per-tier constants so same-tier
 * candidates keep their original order. An empty query matches everything.
 */
export function pinyinAwareMatchScore(candidate: string, query: string): number {
  const text = candidate.toLowerCase();
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  if (text.startsWith(normalized)) return 400;
  const asciiQuery = /^[a-z0-9]+$/.test(normalized);
  const han = containsHan(text);
  if (asciiQuery && han && pinyinFirstLetters(text).startsWith(normalized)) return 300;
  if (text.includes(normalized)) return 200;
  if (asciiQuery && han) {
    const subsequence = orderedSubsequenceSpan(pinyinFirstLetters(text), normalized);
    if (subsequence) return 100;
  }
  return -1;
}
