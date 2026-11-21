export interface MessageWithKind {
  kind?: string;
}

export interface RetryableMessage {
  role: "user" | "assistant";
  content: string;
  mentions?: unknown[];
  csvAttachments?: unknown[];
  imageAttachments?: unknown[];
}

/** Finds the closest preceding user turn that can be submitted again for an
 * assistant reply in the visible transcript. */
export function retryableUserMessageIndex(messages: RetryableMessage[], assistantVisibleIndex: number): number {
  for (let i = assistantVisibleIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (message.content.trim() || message.mentions?.length || message.csvAttachments?.length || message.imageAttachments?.length) return i;
    return -1;
  }
  return -1;
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
