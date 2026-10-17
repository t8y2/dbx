/**
 * Automatic word wrap for the cell-detail value editor (#12320).
 *
 * The global `editorSettings.wordWrap` toggle already wraps everything when
 * enabled, but it defaults to off, so a super long single-line value still
 * forces horizontal scrolling. When wrap is off, fold any single-line document
 * that is long enough to exceed a comfortable viewport width.
 *
 * Multi-line documents (including pretty-printed JSON) keep the user's choice
 * untouched so the toggle semantics stay predictable.
 */
export const CELL_DETAIL_AUTO_WRAP_MIN_LENGTH = 160;

export function shouldAutoWrapLongSingleLine(doc: string): boolean {
  if (doc.length < CELL_DETAIL_AUTO_WRAP_MIN_LENGTH) return false;
  return !doc.includes("\n") && !doc.includes("\r");
}
