export interface AiMessageCopyCandidate {
  role: "user" | "assistant";
  content: string;
  mentions?: readonly AiMessageCopyMention[];
}

export interface AiMessageCopyMention {
  kind: string;
  raw: string;
}

export function resolveAiMessageCopyText(message: AiMessageCopyCandidate, streaming: boolean): string | null {
  if (!message.content || streaming) return null;
  const references = message.mentions?.filter((mention) => mention.kind === "table" || mention.kind === "sqlFile").map((mention) => mention.raw) ?? [];
  return references.length > 0 ? `${references.join(" ")}\n\n${message.content}` : message.content;
}
