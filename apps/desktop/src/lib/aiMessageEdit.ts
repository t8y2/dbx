export interface MessageWithKind {
  kind?: string;
}

/**
 * Maps a visible message index (contextSummary messages excluded) to the
 * actual index in the full messages array.
 * Returns -1 if not found.
 */
export function visibleToActualIndex(messages: MessageWithKind[], visibleIndex: number): number {
  let vi = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].kind !== "contextSummary") {
      if (vi === visibleIndex) return i;
      vi++;
    }
  }
  return -1;
}
