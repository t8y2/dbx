import { describe, expect, it, vi } from "vitest";
import { createAiMessageRenderer } from "@/lib/ai/aiMessageRender";

describe("createAiMessageRenderer", () => {
  it("caches completed short messages", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown, maxCacheableChars: 100 });

    renderer.render("hello");
    renderer.render("hello");

    expect(markdown).toHaveBeenCalledTimes(1);
  });

  it("does not retain long streaming message versions", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown, maxCacheableChars: 5 });

    renderer.render("long message");
    renderer.render("long message");

    expect(markdown).toHaveBeenCalledTimes(2);
  });
});
