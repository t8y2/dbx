import { ChangeSet, Text } from "@codemirror/state";

/** Persist line numbers independently of SQL, which may hydrate from disk later. */
export function normalizePersistedBookmarks(value: unknown): number[] {
  return Array.isArray(value) ? [...new Set(value.filter((line): line is number => Number.isSafeInteger(line) && line >= 1))].sort((a, b) => a - b) : [];
}

/** A single replacement retaining unchanged prefixes/suffixes for editor markers. */
export function bookmarkDocumentChange(previous: string, next: string) {
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
