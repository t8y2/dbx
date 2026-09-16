export interface AiConversationSearchItem {
  title: string;
  connectionName: string;
  database: string;
  messages: readonly { content: string }[];
}

export interface AiConversationSearchEntry<T extends AiConversationSearchItem> {
  conversation: T;
  searchText: string;
}

export function buildAiConversationSearchIndex<T extends AiConversationSearchItem>(conversations: readonly T[]): AiConversationSearchEntry<T>[] {
  return conversations.map((conversation) => ({
    conversation,
    searchText: [conversation.title, conversation.connectionName, conversation.database, ...conversation.messages.map((message) => message.content)].join("\n").toLowerCase(),
  }));
}

export function filterAiConversationSearchIndex<T extends AiConversationSearchItem>(index: readonly AiConversationSearchEntry<T>[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return index.map((entry) => entry.conversation);

  return index.filter((entry) => entry.searchText.includes(normalizedQuery)).map((entry) => entry.conversation);
}
