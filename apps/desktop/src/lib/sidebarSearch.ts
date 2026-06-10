import { parseSlashDelimitedRegexQuery } from "@/lib/searchPattern";

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

  return null;
}

export function createSidebarLabelMatcher(query: string): SidebarLabelMatcher {
  const regex = parseSlashDelimitedRegexQuery(query);
  return (label) => matchSidebarLabelWithRegex(label, query, regex);
}

export function matchSidebarLabel(label: string, query: string): SidebarSearchMatch | null {
  return matchSidebarLabelWithRegex(label, query, parseSlashDelimitedRegexQuery(query));
}
