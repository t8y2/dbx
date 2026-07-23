import { describe, expect, it, vi } from "vitest";
import { createAiMessageRenderer, splitStreamingTextBlocks } from "@/lib/ai/aiMessageRender";

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

  it("keeps a truncated code block pending after the stream stops", () => {
    const markdown = (text: string) => `<p>${text}</p>`;
    const highlightCode = (content: string) => `<span>${content}</span>`;
    const renderer = createAiMessageRenderer({ markdown, highlightCode });

    // A cancelled or truncated answer leaves the fence open: the code must stay non-executable.
    const [truncated] = renderer.render("```sql\nDELETE FROM users WHE");

    expect(truncated).toMatchObject({ type: "code", pending: true, html: "<span>DELETE FROM users WHE</span>" });
  });

  it("keeps a closed code block interactive while later text still streams", () => {
    const markdown = (text: string) => `<p>${text}</p>`;
    const highlightCode = (content: string) => `<span>${content}</span>`;
    const renderer = createAiMessageRenderer({ markdown, highlightCode });

    const [code] = renderer.render("```sql\nSELECT 1\n```\n\nexpl", { streaming: true });

    expect(code).toMatchObject({ type: "code", pending: false, html: "<span>SELECT 1</span>" });
  });

  it("re-parses only the last paragraph of a long streaming answer", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown });
    const paragraph = "查询计划说明".repeat(60);
    const head = `${paragraph}\n\n${paragraph}\n\n`;

    renderer.render(`${head}结论：需要索引`, { streaming: true });
    markdown.mockClear();
    renderer.render(`${head}结论：需要索引。`, { streaming: true });

    expect(markdown).toHaveBeenCalledTimes(1);
    expect(markdown).toHaveBeenCalledWith("结论：需要索引。");
  });

  it("does not split a streaming list across blocks", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown });
    const intro = "步骤说明".repeat(80);
    const content = `${intro}\n\n1. 第一步\n\n2. 第二步`;

    const segments = renderer.render(content, { streaming: true });

    // The list must stay in one block, otherwise the ordered list restarts mid-stream.
    expect(segments).toHaveLength(1);
    expect(markdown).toHaveBeenCalledWith(content);
  });

  it("evicts cached renders once the character budget is exceeded", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown, maxCacheChars: 50 });
    const first = "a".repeat(40);
    const second = "b".repeat(40);

    renderer.render(first);
    renderer.render(second);
    markdown.mockClear();
    renderer.render(first);

    expect(markdown).toHaveBeenCalledTimes(1);
  });

  it("drops cached renders on clear", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown });

    renderer.render("hello");
    renderer.clear();
    renderer.render("hello");

    expect(markdown).toHaveBeenCalledTimes(2);
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

describe("splitStreamingTextBlocks", () => {
  const long = "内容".repeat(200);

  it("keeps short text in a single live block", () => {
    expect(splitStreamingTextBlocks("hello\n\nworld")).toEqual(["hello\n\nworld"]);
  });

  it("splits on a blank line before a new paragraph", () => {
    expect(splitStreamingTextBlocks(`${long}\n\n结论`)).toEqual([`${long}\n\n`, "结论"]);
  });

  it("keeps block markers attached to the block above them", () => {
    for (const marker of ["- 列表项", "1. 第一步", "> 引用", "| a | b |", "  缩进续行", "```", "[1]: https://example.com"]) {
      expect(splitStreamingTextBlocks(`${long}\n\n${marker}`)).toEqual([`${long}\n\n${marker}`]);
    }
  });

  it("does not split when the next block has not arrived yet", () => {
    expect(splitStreamingTextBlocks(`${long}\n\n`)).toEqual([`${long}\n\n`]);
  });

  it("preserves the original text when joined", () => {
    const content = `${long}\n\n第二段${long}\n\n第三段`;
    expect(splitStreamingTextBlocks(content).join("")).toBe(content);
  });
});
