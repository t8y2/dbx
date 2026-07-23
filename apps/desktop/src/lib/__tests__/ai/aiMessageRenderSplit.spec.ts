import { describe, expect, it } from "vitest";
import { splitStreamingTextBlocks } from "@/lib/ai/aiMessageRender";
import { formatAiInlineMarkdown } from "@/lib/ai/aiMarkdown";

const FRAGMENTS = [
  "这是一段普通的中文说明文字，用于填充内容长度。",
  "This is a plain english paragraph used as filler content.",
  "# 一级标题",
  "## 二级标题",
  "- 列表项 A\n- 列表项 B",
  "* 星号列表\n* 第二项",
  "1. 第一步\n2. 第二步",
  "3) 括号序号",
  "> 引用一行\n> 引用第二行",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "~~~sql\nSELECT 1\n~~~",
  "````\nnested ``` fence\n````",
  "```js title=x\nlet a = 1\n```",
  "    缩进代码块",
  "***",
  "---",
  "___",
  "**加粗** 与 *斜体* 与 `行内代码`",
  "[链接](https://example.com) 与 ![图片](https://example.com/a.png)",
  "见 [文档][ref]",
  "<div>html 块</div>",
  "term\n: 定义",
  "行尾两空格  \n下一行",
  "Setext 标题\n===",
  "Setext 二级\n---",
  "- [ ] 任务\n- [x] 完成",
  "脚注引用[^1]",
  "[^1]: 脚注内容",
  "= 等号开头",
  "~波浪线开头",
  ": 冒号开头",
  "\\[转义括号]",
  "第一段结束。",
];

/** Constructs that reach across blank lines; one of them disables splitting for the whole message. */
const CROSS_BLOCK_FRAGMENTS = [
  "[ref]: https://example.com",
  "[多行\n标签]: https://example.com",
  "[a\\]b]: https://example.com",
  "<!-- 注释 -->",
  "<!-- 跨空行注释\n\n仍在注释里 -->",
  "<!DOCTYPE html>",
  "<!FOO bar>",
  "<?php echo 1; ?>",
  "<![CDATA[ x ]]>",
  "<pre>raw</pre>",
  "<script>var a = 1;</script>",
  "<style>a { color: red }</style>",
  "[^1]: 脚注内容",
];

const FILLER = "这里是用于把块撑过切分阈值的填充文字，内容本身没有特殊含义。";

describe("splitStreamingTextBlocks link reference definitions", () => {
  it.each([
    ["blockquote", "> [ref]: https://example.com"],
    ["list", "- [ref]: https://example.com"],
    ["nested list", "- outer\n  - inner\n\n    [ref]: https://example.com"],
    ["nested mixed containers", "> - > 1. [ref]: https://example.com"],
  ])("keeps definitions inside %s joined with later references", (_, definition) => {
    const doc = `${definition}\n\n${FILLER.repeat(8)}\n\nSee [ref].`;
    const blocks = splitStreamingTextBlocks(doc);

    expect(blocks.map(formatAiInlineMarkdown).join("")).toBe(formatAiInlineMarkdown(doc));
    expect(blocks).toEqual([doc]);
  });
});

function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("splitStreamingTextBlocks fuzz", () => {
  it("keeps split rendering identical to whole rendering", () => {
    const random = makeRandom(20260723);
    const failures: string[] = [];
    let splitCases = 0;

    for (let iteration = 0; iteration < 4000; iteration++) {
      const count = 3 + Math.floor(random() * 8);
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        // Cross-block constructs are rarer so that most documents still reach the split path.
        const pool = random() < 0.06 ? CROSS_BLOCK_FRAGMENTS : FRAGMENTS;
        const fragment = pool[Math.floor(random() * pool.length)];
        // Blocks are only split once they pass the size threshold, so pad most of them.
        parts.push(random() < 0.7 ? `${FILLER.repeat(2 + Math.floor(random() * 4))}\n${fragment}` : fragment);
      }
      const doc = parts.join(random() < 0.85 ? "\n\n" : "\n\n\n");
      const blocks = splitStreamingTextBlocks(doc);
      if (blocks.length < 2) continue;
      splitCases++;
      if (blocks.join("") !== doc) failures.push(`join mismatch: ${JSON.stringify(doc.slice(0, 200))}`);
      const split = blocks.map(formatAiInlineMarkdown).join("");
      const whole = formatAiInlineMarkdown(doc);
      if (split !== whole) failures.push(`render mismatch (${blocks.length} blocks): ${JSON.stringify(doc.slice(0, 300))}`);
    }

    expect(failures).toEqual([]);
    // Guards against the corpus degenerating into cases that are never split at all.
    expect(splitCases).toBeGreaterThan(1500);
  });
});
