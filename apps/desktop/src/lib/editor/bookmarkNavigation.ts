export type BookmarkNavigationDirection = "next" | "previous";

/** Sort and de-duplicate bookmark line starts. */
export function normalizeBookmarkLines(lines: Iterable<number>): number[] {
  return [...new Set(lines)].filter((line) => line >= 0).sort((a, b) => a - b);
}

/** Add the line start when it is not bookmarked, otherwise remove it. */
export function toggleBookmarkLine(lines: readonly number[], lineStart: number): number[] {
  const next = new Set(lines);
  if (next.has(lineStart)) next.delete(lineStart);
  else next.add(lineStart);
  return normalizeBookmarkLines(next);
}

/**
 * Resolve the next bookmark line start from the current line.
 *
 * Navigation wraps around so F2 / Shift+F2 keep cycling through the file
 * instead of stopping at the first or last bookmark.
 */
export function nextBookmarkLine(lines: readonly number[], currentLineStart: number, direction: BookmarkNavigationDirection): number | null {
  if (lines.length === 0) return null;
  if (direction === "next") {
    return lines.find((line) => line > currentLineStart) ?? lines[0]!;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]! < currentLineStart) return lines[index]!;
  }
  return lines[lines.length - 1]!;
}
