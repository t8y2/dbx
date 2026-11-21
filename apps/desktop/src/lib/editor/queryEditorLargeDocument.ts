export const QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH = 1024 * 1024;
export const QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT = 2_000;

// The Lezer SQL parser cannot skip ahead: highlighting a viewport at the end of a document means
// parsing everything before it, which costs roughly 100 bytes of short-lived objects per character
// (a 12 MB paste produced ~1.2 GB of garbage and pushed the WebView past 3 GB). Past this size the
// editor highlights with a line-based stream tokenizer instead; execution and the bounded analysis
// never relied on the syntax tree.
export const QUERY_EDITOR_SYNTAX_PARSE_MAX_DOCUMENT_LENGTH = 2 * 1024 * 1024;

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
