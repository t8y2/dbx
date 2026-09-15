import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

describe("AI assistant message wrapping", () => {
  it("allows long unbroken user text such as comma-separated SQL arrays to wrap", () => {
    expect(source).toContain('class="whitespace-pre-wrap [overflow-wrap:anywhere]">{{ msg.content }}</div>');
  });

  it("allows long unbroken fenced code to wrap inside the message bubble", () => {
    expect(source).toContain('class="ai-code-block whitespace-pre-wrap break-words [overflow-wrap:anywhere]');
  });
});
