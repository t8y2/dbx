import { describe, expect, it } from "vitest";
import assistantSource from "../AiAssistant.vue?raw";

describe("AiAssistant typography scope", () => {
  it("uses one scoped content wrapper for streaming and completed Markdown", () => {
    expect(assistantSource).toContain("messageRenderer.value.render(msg.content, { streaming: isStreamingMessage(msg) })");
    expect(assistantSource).toContain('data-ai-assistant-message-content class="ai-conversation-text');
    expect(assistantSource).toContain('data-ai-user-message-content class="whitespace-pre-wrap"');
  });

  it("scopes typography to message and input text while preserving monospace code", () => {
    expect(assistantSource).toContain('data-ai-assistant-root class="flex h-full min-h-0 flex-col overflow-hidden" :style="aiTypographyStyle"');
    expect(assistantSource).toContain('data-edit-textarea\n                    v-model="editingContent"');
    expect(assistantSource).toContain('class="ai-conversation-text w-full resize-none rounded-lg');
    expect(assistantSource).toContain('class="ai-conversation-text w-full resize-none bg-transparent');
    expect(assistantSource).toMatch(/\.ai-markdown :deep\(code\)[\s\S]*font-family: ui-monospace, monospace;/);
    expect(assistantSource).toMatch(/\.ai-code-block \{[\s\S]*font-family: ui-monospace, monospace;/);
    expect(assistantSource).not.toContain("document.body.style.fontFamily");
  });
});
