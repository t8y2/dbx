import assert from "node:assert/strict";
import { test } from "vitest";
import { documentMarkdown, llmsIndex, markdownPath } from "./llms";

test("Markdown endpoints preserve locale and normalize documentation roots", () => {
  assert.equal(markdownPath("/cn/docs/"), "/cn/markdown/index.md");
  assert.equal(markdownPath("/en/docs/mcp"), "/en/markdown/mcp.md");
});

test("document text preserves exact source provenance and code blocks", async () => {
  const body = "## Example\n\n```sql\nSELECT 1;\n```";
  const output = await documentMarkdown({ url: "/cn/docs/mcp", data: { title: "MCP 集成", description: "受控访问", getText: async () => body } });
  assert.ok(output.startsWith("# MCP 集成\n"));
  assert.ok(output.includes("Source: https://dbxio.com/cn/docs/mcp\n"));
  assert.ok(output.includes("Language: zh-CN"));
  assert.ok(output.includes(body));
});

test("LLM index contains both languages without mutating page order", () => {
  const pages = [
    { url: "/en/docs/mcp", data: { title: "MCP", description: "Tools", getText: async () => "" } },
    { url: "/cn/docs/mcp", data: { title: "MCP 集成", description: "工具", getText: async () => "" } },
  ];
  const output = llmsIndex(pages);
  assert.ok(output.includes("https://dbxio.com/en/markdown/mcp.md"));
  assert.ok(output.includes("https://dbxio.com/cn/markdown/mcp.md"));
  assert.ok(output.includes("Apache-2.0"));
  assert.equal(pages[0].url, "/en/docs/mcp");
});
