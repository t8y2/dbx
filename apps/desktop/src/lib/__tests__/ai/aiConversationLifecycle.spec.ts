import { describe, expect, it, vi } from "vitest";
import { deleteConversationWithCancellation, stopAiGenerationWithFallback } from "@/lib/ai/aiConversationLifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AI conversation lifecycle", () => {
  it("abandons the active generation before deleting its conversation", async () => {
    const deletion = deferred();
    const events: string[] = [];

    const pending = deleteConversationWithCancellation({
      id: "conversation-1",
      currentConversationId: () => "conversation-1",
      isGenerating: () => true,
      abandon: () => events.push("abandon"),
      deletePersisted: () => {
        events.push("delete");
        return deletion.promise;
      },
      afterDelete: () => events.push("after-delete"),
    });

    expect(events).toEqual(["abandon", "delete"]);
    deletion.resolve();
    await pending;
    expect(events).toEqual(["abandon", "delete", "after-delete"]);
  });

  it("uses the assistant placeholder created after Stop was clicked", async () => {
    const wait = deferred();
    const messages = [{ content: "question" }, { content: "", isThinking: true }];
    let assistantMessageIndex = -1;
    const abandon = vi.fn();
    const persistConversation = vi.fn().mockResolvedValue(undefined);

    const pending = stopAiGenerationWithFallback({
      isGenerating: () => true,
      currentGeneration: () => 7,
      isGenerationCurrent: (generation) => generation === 7,
      currentSessionId: () => "",
      cancelSession: vi.fn().mockResolvedValue(undefined),
      waitForGenerationToClear: () => wait.promise,
      flushPending: vi.fn(),
      currentAssistantMessageIndex: () => assistantMessageIndex,
      messageAt: (index) => messages[index],
      cancelledMessage: () => "Request cancelled",
      abandon,
      persistConversation,
    });

    assistantMessageIndex = 1;
    wait.resolve();
    await pending;

    expect(messages[1]).toEqual({ content: "Request cancelled", isThinking: false });
    expect(abandon).toHaveBeenCalledWith("");
    expect(persistConversation).toHaveBeenCalledOnce();
  });

  it("persists the finalized partial response after forced abandon", async () => {
    const message = { content: "partial", isThinking: true };
    const events: string[] = [];
    let persistedMessage: typeof message | undefined;

    await stopAiGenerationWithFallback({
      isGenerating: () => true,
      currentGeneration: () => 11,
      isGenerationCurrent: (generation) => generation === 11,
      currentSessionId: () => "session-1",
      cancelSession: async () => {},
      waitForGenerationToClear: async () => {},
      flushPending: () => events.push("flush"),
      currentAssistantMessageIndex: () => 0,
      messageAt: () => message,
      cancelledMessage: () => "Request cancelled",
      abandon: () => events.push("abandon"),
      persistConversation: async () => {
        events.push("persist");
        persistedMessage = { ...message };
      },
    });

    expect(events).toEqual(["flush", "abandon", "persist"]);
    expect(persistedMessage).toEqual({ content: "partial", isThinking: false });
  });
});
