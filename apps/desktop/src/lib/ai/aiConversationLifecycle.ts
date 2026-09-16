export interface AiAssistantLifecycleMessage {
  content: string;
  isThinking?: boolean;
}

interface StopAiGenerationOptions<TGeneration, TMessage extends AiAssistantLifecycleMessage> {
  isGenerating: () => boolean;
  currentGeneration: () => TGeneration;
  isGenerationCurrent: (generation: TGeneration) => boolean;
  currentSessionId: () => string;
  cancelSession: (sessionId: string) => Promise<void>;
  waitForGenerationToClear: () => Promise<void>;
  flushPending: () => void;
  currentAssistantMessageIndex: () => number;
  messageAt: (index: number) => TMessage | undefined;
  cancelledMessage: () => string;
  abandon: (alreadyCancelledSessionId: string) => void;
  persistConversation: () => Promise<void>;
}

export async function stopAiGenerationWithFallback<TGeneration, TMessage extends AiAssistantLifecycleMessage>(options: StopAiGenerationOptions<TGeneration, TMessage>): Promise<boolean> {
  if (!options.isGenerating()) return false;

  const generation = options.currentGeneration();
  const sessionId = options.currentSessionId();
  if (sessionId) await options.cancelSession(sessionId).catch(() => {});

  await options.waitForGenerationToClear();
  if (!options.isGenerating() || !options.isGenerationCurrent(generation)) return false;

  options.flushPending();
  const message = options.messageAt(options.currentAssistantMessageIndex());
  if (message) {
    message.isThinking = false;
    if (!message.content) message.content = options.cancelledMessage();
  }
  options.abandon(sessionId);
  await options.persistConversation();
  return true;
}

interface DeleteConversationOptions {
  id: string;
  currentConversationId: () => string;
  isGenerating: () => boolean;
  abandon: () => void;
  deletePersisted: () => Promise<void>;
  afterDelete: () => void;
}

export async function deleteConversationWithCancellation(options: DeleteConversationOptions): Promise<void> {
  if (options.currentConversationId() === options.id && options.isGenerating()) options.abandon();
  await options.deletePersisted();
  options.afterDelete();
}
