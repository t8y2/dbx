export const QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH = 1024 * 1024;
export const QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT = 2_000;

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
