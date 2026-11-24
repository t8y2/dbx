import { ChangeSet, Text } from "@codemirror/state";
import { diffChars, diffLines } from "diff";

/** Persist line numbers independently of SQL, which may hydrate from disk later. */
export function normalizePersistedBookmarks(value: unknown): number[] {
  return Array.isArray(value) ? [...new Set(value.filter((line): line is number => Number.isSafeInteger(line) && line >= 1))].sort((a, b) => a - b) : [];
}

function singleReplacement(previous: string, next: string) {
  let from = 0;
  while (from < previous.length && from < next.length && previous[from] === next[from]) from++;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { from, to: oldEnd, insert: next.slice(from, newEnd) };
}

/** Preserve unchanged line runs, then unchanged characters within each hunk.
 * Repeated lines use the diff's deterministic, ordered alignment (no global
 * text lookup). Deleted/replaced markers fall back to CodeMirror's boundary
 * mapping. Bound edit distance for unrelated large documents; on exhaustion
 * use the same boundary fallback for the remaining replacement.
 */
export function bookmarkDocumentChange(previous: string, next: string) {
  if (previous === next) return [];
  const parts = diffLines(previous, next, { maxEditLength: 2048 });
  if (!parts) return [singleReplacement(previous, next)];
  const changes: { from: number; to: number; insert: string }[] = [];
  let offset = 0;
  let removed = "";
  let added = "";
  const flush = () => {
    if (!removed && !added) return;
    // Adjacent edited lines may have no whole-line match, but their newlines
    // and unchanged text still anchor markers (e.g. changing three SELECTs).
    const characters = diffChars(removed, added, { maxEditLength: 2048 });
    if (characters) {
      let position = offset;
      for (const part of characters) {
        if (part.added) changes.push({ from: position, to: position, insert: part.value });
        else {
          if (part.removed) changes.push({ from: position, to: position + part.value.length, insert: "" });
          position += part.value.length;
        }
      }
    } else {
      const change = singleReplacement(removed, added);
      changes.push({ from: offset + change.from, to: offset + change.to, insert: change.insert });
    }
    offset += removed.length;
    removed = added = "";
  };
  for (const part of parts) {
    if (part.removed) removed += part.value;
    else if (part.added) added += part.value;
    else {
      flush();
      offset += part.value.length;
    }
  }
  flush();
  return changes;
}

/** Restore a closed tab's markers onto current file content using editor mapping semantics. */
export function mapPersistedBookmarks(previous: string, next: string, lines: readonly number[]): number[] {
  const before = Text.of(previous.split(/\r\n?|\n/));
  const after = Text.of(next.split(/\r\n?|\n/));
  const normalized = normalizePersistedBookmarks(lines);
  // A session snapshot can contain saved markers before its SQL has hydrated.
  if (!previous.length) return normalized.filter((line) => line <= after.lines);
  const changes = ChangeSet.of(bookmarkDocumentChange(before.toString(), after.toString()), before.length);
  return normalizePersistedBookmarks(normalized.filter((line) => line <= before.lines).map((line) => after.lineAt(changes.mapPos(before.line(line).from, 1)).number));
}
