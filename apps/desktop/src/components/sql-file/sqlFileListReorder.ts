import type { SqlFilePreview } from "@/lib/backend/api";

/**
 * Reorder utilities for the SQL file execution dialog.
 *
 * The list is reordered with explicit up/down buttons instead of HTML5
 * drag-and-drop: Tauri 2's default `dragDropEnabled: true` intercepts native
 * drag-drop events at the webview level, which prevents HTML5 drag events from
 * firing reliably inside the desktop app. Button-driven reordering works
 * identically in both web and desktop modes.
 */

/**
 * Move the item at `from` by `delta` positions (-1 = up, +1 = down).
 * Returns a new array; out-of-range moves are no-ops and return the original
 * reference so callers can skip reactive updates.
 */
export function moveFile(previews: SqlFilePreview[], from: number, delta: -1 | 1): SqlFilePreview[] {
  if (previews.length === 0) return previews;
  if (from < 0 || from >= previews.length) return previews;
  const to = from + delta;
  if (to < 0 || to >= previews.length) return previews;
  const next = [...previews];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Remove the item at `index`. Returns a new array; invalid indices are no-ops
 * and return the original reference.
 */
export function removeFile(previews: SqlFilePreview[], index: number): SqlFilePreview[] {
  if (previews.length === 0) return previews;
  if (index < 0 || index >= previews.length) return previews;
  const next = [...previews];
  next.splice(index, 1);
  return next;
}

/** Whether the "move up" button should be enabled for the item at `index`. */
export function canMoveUp(previews: SqlFilePreview[], index: number): boolean {
  return previews.length > 1 && index > 0;
}

/** Whether the "move down" button should be enabled for the item at `index`. */
export function canMoveDown(previews: SqlFilePreview[], index: number): boolean {
  return previews.length > 1 && index >= 0 && index < previews.length - 1;
}
