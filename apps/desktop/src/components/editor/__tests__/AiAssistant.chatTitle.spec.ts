import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/9904:
//
// Renaming the current conversation from the history list updates
// `conversations` and the `renamedConversationTitles` claim map, but the
// panel header rendered `chatTitle` purely from the first user message of
// the panel-local `messages` snapshot, so the top-left title stayed stale
// (reopening the conversation didn't pick the stored title up either).
// AiAssistant.vue is a ~6000-line SFC the suite never mounts, so these
// assertions pin the template/computed wiring as text, matching the house
// source-assertion style.
const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

function bodyOf(fnSignature: string): string {
  const start = source.indexOf(fnSignature);
  expect(start, `expected to find "${fnSignature}" in AiAssistant.vue`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading body of "${fnSignature}"`);
}

describe("AI assistant header title tracks the conversation title", () => {
  it("chatTitle prefers the renamed/stored title of the open conversation over the first-message excerpt", () => {
    // The claim map must stay reactive — it is the header's invalidation link
    // to a rename that commits while the save is still in flight.
    expect(source).toContain("const renamedConversationTitles = reactive(new Map<string, string>());");
    const body = bodyOf("const chatTitle = computed");
    // Both the rename-claim map and the conversation list must be reactive
    // dependencies so a commitRenameConversation() write re-renders the header.
    expect(body).toContain("renamedConversationTitles.get(conversationId.value)");
    expect(body).toContain("conversations.value.find(");
    expect(body).toContain("conversation.id === conversationId.value");
    expect(body).toContain("messages.value.find");
    // Same precedence as buildConversationSnapshot(): the rename claim wins,
    // the stored title comes next, and the first-message excerpt is only the
    // fallback for unsaved/new chats. (The toContain guards above keep these
    // index orderings from passing vacuously at -1.)
    expect(body.indexOf("renamedConversationTitles.get(conversationId.value)")).toBeLessThan(body.indexOf("activeConversation?.title"));
    expect(body.indexOf("renamedConversationTitles.get(conversationId.value)")).toBeLessThan(body.indexOf("messages.value.find"));
    expect(body).toContain("messageTitle(first).slice(0, 30)");
    expect(body).toContain('t("ai.newChat")');
  });

  it("the header renders chatTitle and rename commits feed the sources chatTitle reads", () => {
    expect(source).toContain("{{ chatTitle }}");
    const commit = bodyOf("async function commitRenameConversation(conv: AiConversation)");
    // The claim must be set before the async save (title race guard) and the
    // list entry replaced afterwards — both writes are what make the header
    // reactive to the rename.
    expect(commit).toContain("renamedConversationTitles.set(conv.id, title);");
    expect(commit.indexOf("renamedConversationTitles.set(conv.id, title);")).toBeLessThan(commit.indexOf("await saveAiConversation(updated)"));
    expect(commit).toContain("conversations.value[i] = updated;");
    // A failed save retracts the claim so the header, the history row and the
    // persisted record all keep the old title.
    expect(commit).toContain("renamedConversationTitles.delete(conv.id);");
  });

  it("pending-input recovery keeps a renamed title instead of re-deriving it from the first message", () => {
    // A recovered queued run used to persist `messageTitle(first)` outright,
    // overwriting a renamed title on disk (and, via syncPersistedConversation,
    // in the list the header now reads).
    const recovery = bodyOf("async function persistPendingInputRecovery(");
    expect(recovery).toContain("renamedConversationTitles.get(conversation.id)");
    expect(recovery.indexOf("renamedConversationTitles.get(conversation.id)")).toBeLessThan(recovery.indexOf("messageTitle(first)"));
  });
});
