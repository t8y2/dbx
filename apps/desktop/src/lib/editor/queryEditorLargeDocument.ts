export const QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH = 1024 * 1024;
export const QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT = 2_000;

// The Lezer SQL parser cannot skip ahead: highlighting a viewport at the end of a document means
// parsing everything before it, which costs roughly 100 bytes of short-lived objects per character
// (a 12 MB paste produced ~1.2 GB of garbage and pushed the WebView past 3 GB). Past this size the
// editor highlights with a line-based stream tokenizer instead; execution and the bounded analysis
// never relied on the syntax tree. Keep this strictly below MAX_PERSISTED_TAB_SQL_CHARS (2 MB) so
// a truncated persisted tab restores directly in stream mode instead of parsing 2 MB with Lezer
// on both the main thread and the statement-analysis worker at startup.
export const QUERY_EDITOR_SYNTAX_PARSE_MAX_DOCUMENT_LENGTH = 1_536 * 1024;

// Automatic completion after an edit is meant for typing, deletions and small pastes. Bulk pastes
// larger than this never want a completion popup and must not trigger full-document completion
// analysis right after paste.
export const QUERY_EDITOR_DEFERRED_COMPLETION_MAX_EDIT_CHARS = 4_096;

export function shouldParseQueryEditorSyntax(documentLength: number): boolean {
  return documentLength <= QUERY_EDITOR_SYNTAX_PARSE_MAX_DOCUMENT_LENGTH;
}

export function shouldUseQueryEditorLargeDocumentModeForSize(documentLength: number, lineCount: number): boolean {
  return documentLength > QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH || lineCount > QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT;
}

export function shouldUseQueryEditorLargeDocumentMode(document: string): boolean {
  if (document.length > QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH) return true;
  let lineCount = 1;
  for (let offset = document.indexOf("\n"); offset >= 0; offset = document.indexOf("\n", offset + 1)) {
    lineCount += 1;
    if (lineCount > QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT) return true;
  }
  return false;
}
