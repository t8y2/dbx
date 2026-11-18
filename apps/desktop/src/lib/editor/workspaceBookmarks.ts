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
