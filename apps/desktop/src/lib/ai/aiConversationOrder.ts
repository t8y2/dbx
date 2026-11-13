/**
 * Ordering for the AI conversation history list (#14226).
 *
 * One comparator, shared by every consumer: the backend `ORDER BY pinned DESC,
 * updated_at DESC`, the in-memory list after each save (`syncPersistedConversation`),
 * and the search results. When these drift, a pinned conversation can jump to
 * the bottom of the list after a save even though it is still pinned on disk.
 *
 * `updatedAt` stays the tie-breaker inside each group on purpose. Pinning must
 * not promote an old conversation above a newer one in "most recently used"
 * terms: `restoreLastConversation` picks the newest conversation, and that is
 * what `mostRecentConversation` below exists to express explicitly.
 */
export interface AiConversationOrderable {
  pinned?: boolean;
  updatedAt: string;
}

/** Pinned first, then most recently updated. Never mutates the input. */
export function compareAiConversations(left: AiConversationOrderable, right: AiConversationOrderable): number {
  const pinnedDelta = (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0);
  if (pinnedDelta !== 0) return pinnedDelta;
  return right.updatedAt.localeCompare(left.updatedAt);
}

export function sortAiConversations<T extends AiConversationOrderable>(conversations: readonly T[]): T[] {
  return [...conversations].sort(compareAiConversations);
}

/**
 * The conversation "restore last conversation" should open: the most recently
 * updated one, pinned or not. Pinning deliberately does not change this — a
 * pinned conversation the user has not touched in weeks must not hijack the
 * next launch.
 */
export function mostRecentConversation<T extends AiConversationOrderable>(conversations: readonly T[]): T | undefined {
  let newest: T | undefined;
  for (const conversation of conversations) {
    if (!newest || conversation.updatedAt.localeCompare(newest.updatedAt) > 0) newest = conversation;
  }
  return newest;
}

/** Splits an already-ordered list into the two sections the history panel renders. */
export function splitPinnedConversations<T extends AiConversationOrderable>(ordered: readonly T[]): { pinned: T[]; recent: T[] } {
  const pinned: T[] = [];
  const recent: T[] = [];
  for (const conversation of ordered) (conversation.pinned ? pinned : recent).push(conversation);
  return { pinned, recent };
}
