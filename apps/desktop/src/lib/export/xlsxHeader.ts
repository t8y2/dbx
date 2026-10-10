export type XlsxHeaderMode = "name" | "comment" | "name-comment" | "name-comment-rows";

export interface XlsxExportOptions {
  headerMode: XlsxHeaderMode;
  autoFilter: boolean;
}

export function hasXlsxHeaderComments(comments: readonly (string | null | undefined)[] | undefined): boolean {
  return comments?.some((comment) => !!comment?.trim()) ?? false;
}

/** True when the header mode renders comments on a separate second row. */
export function xlsxHeaderUsesCommentRows(mode: XlsxHeaderMode): boolean {
  return mode === "name-comment-rows";
}

export function buildXlsxHeaderOverrides(columns: readonly string[], comments: readonly (string | null | undefined)[] | undefined, mode: XlsxHeaderMode): (string | null)[] | undefined {
  if (mode === "name") return undefined;
  if (mode === "name-comment-rows") {
    // The comments render as their own header row, so they travel as plain
    // comment data (paired with the headerCommentRows flag) instead of
    // overriding the header text.
    const overrides = columns.map((_, index) => comments?.[index]?.trim() || null);
    return overrides.some((header) => header !== null) ? overrides : undefined;
  }

  const overrides = columns.map((column, index) => {
    const comment = comments?.[index]?.trim();
    if (!comment) return null;
    return mode === "comment" ? comment : `${column} (${comment})`;
  });

  return overrides.some((header) => header !== null) ? overrides : undefined;
}
