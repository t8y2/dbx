import { describe, expect, it, vi } from "vitest";
import { createAiMessageRenderer, splitStreamingTextBlocks } from "@/lib/ai/aiMessageRender";
import { formatAiInlineMarkdown } from "@/lib/ai/aiMarkdown";

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
    // Half of the budget goes to the message cache, so two ~90 char entries do not fit together.
    const renderer = createAiMessageRenderer({ markdown, maxCacheChars: 300 });
    const first = "a".repeat(40);
    const second = "b".repeat(40);

    renderer.render(first);
    renderer.render(second);
    markdown.mockClear();
    renderer.render(first);

    expect(markdown).toHaveBeenCalledTimes(1);
  });

  it("does not cache an entry that alone exceeds the budget", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown, maxCacheChars: 10 });

    renderer.render("hello");
    renderer.render("hello");

    expect(markdown).toHaveBeenCalledTimes(2);
  });

  it("drops cached renders on clear", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown });

    renderer.render("hello");
    renderer.clear();
    renderer.render("hello");

    expect(markdown).toHaveBeenCalledTimes(2);
  });

  it("keeps reusing stable blocks past the shared cache limits", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    // Far more stable blocks than the shared caches can hold.
    const renderer = createAiMessageRenderer({ markdown, maxEntries: 2, maxSegmentEntries: 2, maxCacheChars: 200 });
    const head = Array.from({ length: 40 }, (_, i) => `${i}:${"内容".repeat(150)}`).join("\n\n") + "\n\n";

    renderer.render(`${head}尾`, { streaming: true });
    markdown.mockClear();
    renderer.render(`${head}尾巴`, { streaming: true });

    expect(markdown).toHaveBeenCalledTimes(1);
  });

  it("drops the streaming blocks when another answer starts", () => {
    const markdown = vi.fn((text: string) => `<p>${text}</p>`);
    const renderer = createAiMessageRenderer({ markdown });
    const head = `${"内容".repeat(200)}\n\n`;

    renderer.render(`${head}尾`, { streaming: true });
    renderer.render("另一个回答", { streaming: true });
    markdown.mockClear();
    renderer.render(`${head}尾`, { streaming: true });

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

  it("does not split inside a tilde or annotated fence", () => {
    // parseAiMessage only extracts plain ``` fences, so these stay in the text segment.
    expect(splitStreamingTextBlocks(`${long}\n\n~~~sql\nSELECT 1\n\nSELECT 2\n~~~`)).toHaveLength(1);
    expect(splitStreamingTextBlocks("````\n" + long + "\n\n还有内容\n````")).toHaveLength(1);
  });

  it("splits again after a fence closes", () => {
    const blocks = splitStreamingTextBlocks(`~~~sql\nSELECT 1\n\nSELECT 2\n~~~\n\n${long}\n\n结论`);

    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toBe("结论");
  });

  it("does not split a message that defines link references", () => {
    expect(splitStreamingTextBlocks(`[1]: https://example.com\n\n${long}\n\n见 [文档][1]`)).toHaveLength(1);
    // The label may escape its closing bracket or wrap onto the next line.
    expect(splitStreamingTextBlocks(`[a\\]b]: https://example.com\n\n${long}\n\n见 [文档][a\\]b]`)).toHaveLength(1);
    expect(splitStreamingTextBlocks(`[a\nb]: https://example.com\n\n${long}\n\n见 [文档][a b]`)).toHaveLength(1);
  });

  it("does not split a message containing raw HTML blocks", () => {
    expect(splitStreamingTextBlocks(`${long}\n\n<!-- 注释开始\n\n注释结束 -->`)).toHaveLength(1);
    expect(splitStreamingTextBlocks(`${long}\n\n<pre>\n\n还有内容\n</pre>`)).toHaveLength(1);
    expect(splitStreamingTextBlocks(`<!DOCTYPE html ${long}\n\n# 标题`)).toHaveLength(1);
  });

  it("does not split when the next block has not arrived yet", () => {
    expect(splitStreamingTextBlocks(`${long}\n\n`)).toEqual([`${long}\n\n`]);
  });

  it("preserves the original text when joined", () => {
    const content = `${long}\n\n第二段${long}\n\n第三段`;
    expect(splitStreamingTextBlocks(content).join("")).toBe(content);
  });

  it("renders the same HTML whether the text is split or not", () => {
    const pad = "这里是一段较长的说明文字，用来把块撑到切分阈值以上。".repeat(12);
    const samples = [
      `${pad}\n\n结论：加索引`,
      `${pad}\n\n## 小标题\n\n正文内容`,
      `${pad}\n\n- 列表项一\n- 列表项二`,
      `${pad}\n\n1. 第一步\n\n2. 第二步`,
      `${pad}\n\n| a | b |\n| --- | --- |\n| 1 | 2 |`,
      `${pad}\n\n> 引用内容\n\n> 第二段引用`,
      `${pad}\n\n~~~sql\nSELECT 1\n\nSELECT 2\n~~~`,
      `${pad}\n\n    缩进代码\n\n    第二行`,
      `[1]: https://example.com\n\n${pad}\n\n见 [文档][1]`,
      `${pad}\n\n**加粗**开头的段落\n\n${pad}\n\n最后一段`,
      `${pad}\n\n\n\n多个空行分隔\n\n结尾`,
      `# 标题\n\n${pad}\n\n![图片](https://example.com/a.png)`,
    ];

    for (const sample of samples) {
      const blocks = splitStreamingTextBlocks(sample);
      expect(blocks.join("")).toBe(sample);
      expect(blocks.map(formatAiInlineMarkdown).join("")).toBe(formatAiInlineMarkdown(sample));
    }
  });
});
