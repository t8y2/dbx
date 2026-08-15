import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

describe("AI assistant message copy actions", () => {
  it("exposes copy actions below user and assistant messages", () => {
    expect(source).toContain('data-ai-message-copy="user"');
    expect(source).toContain('data-ai-message-copy="assistant"');
  });

  it("routes message copies through the body-only copy contract", () => {
    expect(source).toContain("resolveAiMessageCopyText(msg, isStreamingMessage(msg))");
    expect(source).toContain("copyAiContent(text, `message:${index}`)");
  });

  it("keeps code-block and message feedback keys separate", () => {
    expect(source).toContain("copyAiContent(seg.content, `code:${i}:${j}`)");
    expect(source).toContain("messageCopyKey(i)");
  });
});
