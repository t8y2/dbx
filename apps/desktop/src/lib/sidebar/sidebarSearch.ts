import { compileSearchRegex, parseSlashDelimitedRegexQuery } from "@/lib/common/searchPattern";

export type SidebarSearchMatchKind = "exact" | "prefix" | "word-prefix" | "substring" | "abbreviation" | "fuzzy" | "regex";

export interface SidebarSearchMatch {
  kind: SidebarSearchMatchKind;
  score: number;
}

export type SidebarLabelMatcher = (label: string) => SidebarSearchMatch | null;

function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  if (prev === "_" || prev === "-" || prev === "." || prev === " " || prev === "/" || prev === "\\") return true;
  // camelCase transition: "camelCaseTable" reads as "camel" | "Case" | "Table".
  // Extends word segmentation only — tier priority and labels without a
  // lowercase-to-uppercase transition are unchanged.
  const curr = text[index];
  return prev >= "a" && prev <= "z" && curr >= "A" && curr <= "Z";
}

const SEPARATOR_RE = /[_\-. /\\]/g;

/**
 * Strip common word separators from a label to enable matching that
 * ignores separator characters.  For example, searching "delo" will
 * match "del_order" because the stripped form "delorder" starts with
 * "delo".
 */
function stripSeparators(text: string): string {
  return text.replace(SEPARATOR_RE, "");
}

// Boundary-aware helpers take the ORIGINAL label so `isWordBoundary` can see
// camelCase transitions, and a LOWER-CASED query. `toLowerCase` preserves
// string length, so label/query indices stay aligned.

function matchesWordPrefix(text: string, query: string): boolean {
  const lowerText = text.toLowerCase();
  for (let i = 0; i < text.length; i++) {
    if (isWordBoundary(text, i) && lowerText.startsWith(query, i)) return true;
  }
  return false;
}

function matchesAbbreviation(text: string, query: string): boolean {
  const lowerText = text.toLowerCase();
  let j = 0;
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (isWordBoundary(text, i) && lowerText[i] === query[j]) j++;
  }
  return j === query.length;
}

function matchesSubsequence(text: string, query: string): boolean {
  if (query.length < 2 || query.length > text.length) return false;

  const lowerText = text.toLowerCase();
  let j = 0;
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (isWordBoundary(text, i) && i > 0) {
      j = 0;
    }
    if (lowerText[i] === query[j]) j++;
  }
  return j === query.length;
}

const MIN_CONCAT_PREFIX_LEN = 2;

/**
 * Split an identifier into words for word-segment prefix concatenation.
 * Splits on the same separators as `isWordBoundary`/`stripSeparators` and on
 * camelCase transitions ("camelCaseTable" -> "camel", "Case", "Table").
 * Original case is preserved so transitions stay detectable.
 */
function splitLabelWords(label: string): string[] {
  const words: string[] = [];
  for (const segment of label.split(SEPARATOR_RE)) {
    if (!segment) continue;
    let start = 0;
    for (let index = 1; index < segment.length; index++) {
      const prev = segment[index - 1];
      const curr = segment[index];
      if (prev >= "a" && prev <= "z" && curr >= "A" && curr <= "Z") {
        words.push(segment.slice(start, index));
        start = index;
      }
    }
    words.push(segment.slice(start));
  }
  return words;
}

/**
 * Word-segment prefix concatenation (DataGrip-style). A query matches when it
 * can be split into k >= 2 pieces, each length >= 2 and a prefix of a distinct
 * label word consumed in order (words may be skipped). This is the tier that
 * makes "exclog" match "system_exception_log" ("exc" from exception + "log")
 * and "syslog" match it (skipping the middle word). The min-2-chars-per-piece
 * rule keeps loose cross-word queries ("roles" on "sys_role_data_scope",
 * "urf" on "user_profile") from matching. Matching is case-insensitive so the
 * camelCase words found by `splitLabelWords` align with lowercase queries.
 */
function matchesWordPrefixConcatenation(label: string, query: string): boolean {
  const words = splitLabelWords(label);
  if (words.length < 2 || query.length < 2 * MIN_CONCAT_PREFIX_LEN) return false;

  const lowerQuery = query.toLowerCase();
  const queryLength = query.length;
  const INF = Infinity;
  // dp[j] = fewest words needed to consume lowerQuery[0..j).
  let dp = Array.from({ length: queryLength + 1 }, () => INF);
  dp[0] = 0;
  for (const word of words) {
    const next = [...dp];
    const lowerWord = word.toLowerCase();
    for (let j = 0; j < queryLength; j++) {
      if (dp[j] === INF) continue;
      const maxLen = Math.min(word.length, queryLength - j);
      for (let len = MIN_CONCAT_PREFIX_LEN; len <= maxLen; len++) {
        if (lowerWord.startsWith(lowerQuery.slice(j, j + len))) {
          next[j + len] = Math.min(next[j + len], dp[j] + 1);
        }
      }
    }
    dp = next;
  }
  return dp[queryLength] !== INF && dp[queryLength] >= 2;
}

function testRegex(regex: RegExp, value: string): boolean {
  // Global and sticky expressions retain lastIndex between calls.  Search
  // candidates are independent values, so every candidate must start from a
  // deterministic index (and leave no state for the next tree row).
  regex.lastIndex = 0;
  const matched = regex.test(value);
  regex.lastIndex = 0;
  return matched;
}

function matchSidebarLabelWithRegex(label: string, query: string, regex: RegExp | null, invalidRegex = false): SidebarSearchMatch | null {
  if (!query) return null;

  if (invalidRegex) return null;

  if (regex) return testRegex(regex, label) ? { kind: "regex", score: 95 } : null;

  // Case-insensitive comparison is centralized here so callers can pass the
  // original label and query. The original label is what the boundary-aware
  // tiers below need to detect camelCase transitions ("camelCaseTable" reads
  // as "camel" | "Case" | "Table").
  const lowerLabel = label.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerLabel === lowerQuery) return { kind: "exact", score: 100 };
  if (lowerLabel.startsWith(lowerQuery)) return { kind: "prefix", score: 90 };
  if (matchesWordPrefix(label, lowerQuery)) return { kind: "word-prefix", score: 80 };
  if (lowerLabel.includes(lowerQuery)) return { kind: "substring", score: 70 };
  if (lowerQuery.length >= 2 && matchesAbbreviation(label, lowerQuery)) return { kind: "abbreviation", score: 60 };
  if (matchesSubsequence(label, lowerQuery)) return { kind: "fuzzy", score: 40 };

  // Separator-blind matching: strip underscores, hyphens, dots, spaces,
  // and slashes, then try again.  This lets "delo" match "del_order"
  // without typing the underscore separator between prefix and name.
  const stripped = stripSeparators(lowerLabel);
  if (stripped !== lowerLabel && stripped.length >= lowerQuery.length) {
    if (stripped.startsWith(lowerQuery)) return { kind: "word-prefix", score: 65 };
    if (stripped.includes(lowerQuery)) return { kind: "substring", score: 55 };
  }

  // Word-segment prefix concatenation: lets "exclog" find
  // "system_exception_log". Uses the ORIGINAL label so camelCase boundaries
  // survive for word segmentation, and compares case-insensitively. Flat 50
  // keeps it below every existing tier — purely additive.
  if (matchesWordPrefixConcatenation(label, query)) {
    return { kind: "abbreviation", score: 50 };
  }

  return null;
}

export interface SidebarSearchMatcherOptions {
  regexMode?: boolean;
}

function slashDelimitedCandidate(query: string): boolean {
  return query.startsWith("/") && query.lastIndexOf("/") > 0;
}

export function createSidebarLabelMatcher(query: string, options: SidebarSearchMatcherOptions = {}): SidebarLabelMatcher {
  if (options.regexMode) {
    const compiled = compileSearchRegex(query);
    return (label) => matchSidebarLabelWithRegex(label, query, compiled.regex, compiled.invalid);
  }

  const regex = parseSlashDelimitedRegexQuery(query);
  // A slash-delimited expression is an explicit regex request even when it is
  // malformed.  Do not silently reinterpret an invalid pattern as fuzzy text.
  const invalidRegex = slashDelimitedCandidate(query) && !regex;
  return (label) => matchSidebarLabelWithRegex(label, query, regex, invalidRegex);
}

export function matchSidebarLabel(label: string, query: string, options: SidebarSearchMatcherOptions = {}): SidebarSearchMatch | null {
  return createSidebarLabelMatcher(query, options)(label);
}
