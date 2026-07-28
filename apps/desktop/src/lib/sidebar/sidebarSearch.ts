import { parseSlashDelimitedRegexQuery } from "@/lib/common/searchPattern";

export type SidebarSearchMatchKind = "exact" | "prefix" | "word-prefix" | "substring" | "abbreviation" | "fuzzy" | "regex";

export interface SidebarSearchMatch {
  kind: SidebarSearchMatchKind;
  score: number;
}

export type SidebarLabelMatcher = (label: string) => SidebarSearchMatch | null;

function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return prev === "_" || prev === "-" || prev === "." || prev === " " || prev === "/" || prev === "\\";
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

function matchesWordPrefix(text: string, query: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isWordBoundary(text, i) && text.startsWith(query, i)) return true;
  }
  return false;
}

function matchesAbbreviation(text: string, query: string): boolean {
  let j = 0;
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (isWordBoundary(text, i) && text[i] === query[j]) j++;
  }
  return j === query.length;
}

function matchesSubsequence(text: string, query: string): boolean {
  if (query.length < 2 || query.length > text.length) return false;

  let j = 0;
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (isWordBoundary(text, i) && i > 0) {
      j = 0;
    }
    if (text[i] === query[j]) j++;
  }
  return j === query.length;
}

function matchSidebarLabelWithRegex(label: string, query: string, regex: RegExp | null): SidebarSearchMatch | null {
  if (!query) return null;

  if (regex) return regex.test(label) ? { kind: "regex", score: 95 } : null;

  if (label === query) return { kind: "exact", score: 100 };
  if (label.startsWith(query)) return { kind: "prefix", score: 90 };
  if (matchesWordPrefix(label, query)) return { kind: "word-prefix", score: 80 };
  if (label.includes(query)) return { kind: "substring", score: 70 };
  if (query.length >= 2 && matchesAbbreviation(label, query)) return { kind: "abbreviation", score: 60 };
  if (matchesSubsequence(label, query)) return { kind: "fuzzy", score: 40 };

  // Separator-blind matching: strip underscores, hyphens, dots, spaces,
  // and slashes, then try again.  This lets "delo" match "del_order"
  // without typing the underscore separator between prefix and name.
  const stripped = stripSeparators(label);
  if (stripped !== label && stripped.length >= query.length) {
    if (stripped.startsWith(query)) return { kind: "word-prefix", score: 65 };
    if (stripped.includes(query)) return { kind: "substring", score: 55 };
  }

  return null;
}

export function createSidebarLabelMatcher(query: string): SidebarLabelMatcher {
  const regex = parseSlashDelimitedRegexQuery(query);
  return (label) => matchSidebarLabelWithRegex(label, query, regex);
}

export function matchSidebarLabel(label: string, query: string): SidebarSearchMatch | null {
  return matchSidebarLabelWithRegex(label, query, parseSlashDelimitedRegexQuery(query));
}
