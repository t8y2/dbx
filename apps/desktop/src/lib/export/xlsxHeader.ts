export type XlsxHeaderMode = "name" | "comment" | "name-comment";

export interface XlsxExportOptions {
  headerMode: XlsxHeaderMode;
  autoFilter: boolean;
}

export function hasXlsxHeaderComments(comments: readonly (string | null | undefined)[] | undefined): boolean {
  return comments?.some((comment) => !!comment?.trim()) ?? false;
}

export function buildXlsxHeaderOverrides(columns: readonly string[], comments: readonly (string | null | undefined)[] | undefined, mode: XlsxHeaderMode): (string | null)[] | undefined {
  if (mode === "name") return undefined;

  const overrides = columns.map((column, index) => {
    const comment = comments?.[index]?.trim();
    if (!comment) return null;
    return mode === "comment" ? comment : `${column} (${comment})`;
  });

  return overrides.some((header) => header !== null) ? overrides : undefined;
}
