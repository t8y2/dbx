import type { EditorState, TransactionSpec } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";

export interface EditorSearchQueryOptions {
  search: string;
  replace?: string;
  caseSensitive: boolean;
  useRegex: boolean;
}

export function createEditorSearchQuery(options: EditorSearchQueryOptions): SearchQuery {
  return new SearchQuery({
    search: options.search,
    replace: options.replace ?? "",
    caseSensitive: options.caseSensitive,
    regexp: options.useRegex,
    literal: !options.useRegex,
  });
}

export interface EditorSearchMatch {
  from: number;
  to: number;
}

export function collectEditorSearchMatches(query: SearchQuery, state: EditorState, from: number, to: number, limit = Number.POSITIVE_INFINITY): EditorSearchMatch[] {
  const matches: EditorSearchMatch[] = [];
  const cursor = query.getCursor(state);

  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    if (result.value.from >= from && result.value.to <= to) {
      matches.push({ from: result.value.from, to: result.value.to });
      if (matches.length >= limit) break;
    }
  }

  return matches;
}

export function replaceEditorSearchMatches(view: { dispatch(spec: TransactionSpec): void }, matches: readonly EditorSearchMatch[], replacement: (match: EditorSearchMatch) => string): boolean {
  if (matches.length === 0) return false;

  view.dispatch({
    changes: matches.map((match) => ({
      from: match.from,
      to: match.to,
      insert: replacement(match),
    })),
  });
  return true;
}
