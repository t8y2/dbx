export interface AiMessageCopyCandidate {
  role: "user" | "assistant";
  content: string;
}

/**
 * Keeps message-level copy payloads scoped to the original message body.
 * Reasoning, tool activity, mentions, and rendered HTML live outside this
 * contract and must not be appended by the caller.
 */
export function resolveAiMessageCopyText(message: AiMessageCopyCandidate, streaming: boolean): string | null {
  if (!message.content || streaming) return null;
  return message.content;
}
