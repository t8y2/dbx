export const QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH = 1024 * 1024;

export function shouldUseQueryEditorLargeDocumentMode(document: string): boolean {
  return document.length > QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH;
}
