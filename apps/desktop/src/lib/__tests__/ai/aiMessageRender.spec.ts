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

  it("renders Markdown for a streaming message", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown });

    const segments = renderer.render("**bold**", { streaming: true });

    expect(segments).toEqual([{ type: "text", content: "**bold**", html: "<p>**bold**</p>" }]);
  });

  it("re-renders only the growing tail while streaming", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown });

    const first = renderer.render("intro\n\n```sql\nSELECT 1\n```\n\ntai", { streaming: true });
    markdown.mockClear();
    const second = renderer.render("intro\n\n```sql\nSELECT 1\n```\n\ntail", { streaming: true });

    expect(markdown).toHaveBeenCalledTimes(1);
    expect(markdown).toHaveBeenCalledWith("\ntail");
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("skips highlighting an unfinished code block and highlights it once closed", () => {
    const markdown = (text: string) => `<p>${text}</p>`;
    const highlightCode = vi.fn((content: string) => `<span>${content}</span>`);
    const renderer = createAiMessageRenderer({ markdown, highlightCode });

    const [streamed] = renderer.render("```sql\nSELECT 1", { streaming: true });
    expect(streamed).toEqual({ type: "code", content: "SELECT 1", html: "SELECT 1", lang: "SQL", isSql: true, pending: true });
    expect(highlightCode).not.toHaveBeenCalled();

    const [closed] = renderer.render("```sql\nSELECT 1\n```");
    expect(closed).toEqual({ type: "code", content: "SELECT 1", html: "<span>SELECT 1</span>", lang: "SQL", isSql: true, pending: false });
  });

  it("keeps a closed code block interactive while later text still streams", () => {
    const markdown = (text: string) => `<p>${text}</p>`;
    const highlightCode = (content: string) => `<span>${content}</span>`;
    const renderer = createAiMessageRenderer({ markdown, highlightCode });

    const [code] = renderer.render("```sql\nSELECT 1\n```\n\nexpl", { streaming: true });

    expect(code).toMatchObject({ type: "code", pending: false, html: "<span>SELECT 1</span>" });
  });

  it("does not cache streaming versions as finished messages", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown, maxEntries: 2 });

    renderer.render("a", { streaming: true });
    renderer.render("ab", { streaming: true });
    renderer.render("abc", { streaming: true });
    markdown.mockClear();

    renderer.render("abc");
    renderer.render("abc");

    expect(markdown).toHaveBeenCalledTimes(1);
  });
});
