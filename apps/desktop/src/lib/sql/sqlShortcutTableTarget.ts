import { extractQualifiedIdentifierAt, isSqlKeyword } from "@/lib/sql/sqlNavigation";

export type SqlShortcutTableSelection = {
  from: number;
  to: number;
  empty: boolean;
  /** Cursor / selection head used when selection is empty. */
  head: number;
};

function identifierAtCursor(doc: string, pos: number): { start: number; end: number } | null {
  let located = extractQualifiedIdentifierAt(doc, pos);
  // CodeMirror can report the boundary immediately after the token.
  if (!located && pos > 0) located = extractQualifiedIdentifierAt(doc, pos - 1);
  if (!located || located.parts.length === 0) return null;
  const last = located.parts[located.parts.length - 1]!;
  if (!last.quoted && isSqlKeyword(last.value)) return null;
  return { start: located.start, end: located.end };
}

/**
 * Resolve the `${table}` token for SQL quick actions:
 * non-empty selection wins; otherwise use the qualified identifier under the cursor
 * (preserving original quotes and dots from the document).
 */
export function resolveSqlShortcutTableToken(doc: string, selection: SqlShortcutTableSelection): string | null {
  if (!selection.empty) {
    const selected = doc.slice(selection.from, selection.to).trim();
    return selected.length > 0 ? selected : null;
  }
  const located = identifierAtCursor(doc, selection.head);
  if (!located) return null;
  const token = doc.slice(located.start, located.end).trim();
  return token.length > 0 ? token : null;
}
