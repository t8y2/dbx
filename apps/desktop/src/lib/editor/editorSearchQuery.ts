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
