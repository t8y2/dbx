import { describe, expect, it } from "vitest";
import { resolveAiMessageCopyText } from "@/lib/ai/aiMessageCopy";

describe("AI message copy payload", () => {
  it("preserves user message text exactly", () => {
    const content = "Check `orders`\n\n```sql\nSELECT * FROM orders;\n```";

    expect(resolveAiMessageCopyText({ role: "user", content }, false)).toBe(content);
  });

  it("copies only the assistant message body", () => {
    const message = {
      role: "assistant" as const,
      content: "The result is **42**.",
      reasoning: "private reasoning",
      agentSteps: [{ toolResult: "tool output" }],
    };

    expect(resolveAiMessageCopyText(message, false)).toBe(message.content);
  });

  it("does not expose empty or streaming messages", () => {
    expect(resolveAiMessageCopyText({ role: "assistant", content: "partial" }, true)).toBeNull();
    expect(resolveAiMessageCopyText({ role: "assistant", content: "" }, false)).toBeNull();
  });
});
