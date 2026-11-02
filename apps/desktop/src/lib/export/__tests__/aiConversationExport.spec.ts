import { describe, expect, it } from "vitest";
import { buildAiConversationExport, type AiConversationExportLabels, type AiConversationExportMessage } from "../aiConversationExport";

const LABELS: AiConversationExportLabels = {
  analysisLabel: "AI Analysis",
  userLabel: "User",
  assistantLabel: "AI",
  failedLabel: "This reply failed to generate",
};

const BASE = {
  connectionName: "prod-mysql",
  dateLabel: "2026-09-08 10:00:00",
  labels: LABELS,
};

function msg(partial: Partial<AiConversationExportMessage> & Pick<AiConversationExportMessage, "role" | "content">): AiConversationExportMessage {
  return partial;
}

describe("buildAiConversationExport", () => {
  it("returns null for an empty conversation (no messages or whitespace-only content)", () => {
    expect(buildAiConversationExport({ ...BASE, messages: [], format: "markdown" })).toBeNull();
    expect(buildAiConversationExport({ ...BASE, messages: [msg({ role: "assistant", content: "   \n  " })], format: "markdown" })).toBeNull();
  });

  it("returns null when every message is a hidden contextSummary entry", () => {
    const result = buildAiConversationExport({
      ...BASE,
      messages: [msg({ role: "assistant", content: "internal summary", kind: "contextSummary" })],
      format: "markdown",
    });
    expect(result).toBeNull();
  });

  it("markdown export writes header, role headings, and message content verbatim", () => {
    const result = buildAiConversationExport({
      ...BASE,
      messages: [msg({ role: "user", content: "按地区统计销售额" }), msg({ role: "assistant", content: '```chart-json\n{"version":1,"type":"bar"}\n```\n华东最高。' })],
      format: "markdown",
    });
    expect(result).not.toBeNull();
    const md = result!.content;
    expect(md).toContain("# prod-mysql · AI Analysis");
    expect(md).toContain("2026-09-08 10:00:00");
    expect(md).toContain("## User");
    expect(md).toContain("## AI");
    expect(md).toContain("按地区统计销售额");
    // chart-json fence survives byte-identical (zero data loss, round-tripable)
    expect(md).toContain('```chart-json\n{"version":1,"type":"bar"}\n```');
    expect(result!.defaultFileName).toMatch(/^prod-mysql_\d{12}\.md$/);
  });

  it("markdown export marks failed assistant replies", () => {
    const result = buildAiConversationExport({
      ...BASE,
      messages: [msg({ role: "assistant", content: "AI request failed\n\nboom", failed: true })],
      format: "markdown",
    });
    expect(result!.content).toContain(`**${LABELS.failedLabel}**`);
  });

  it("html export escapes raw HTML in message content", () => {
    const result = buildAiConversationExport({
      ...BASE,
      messages: [msg({ role: "assistant", content: '<script>alert("x")</script>' }), msg({ role: "user", content: '<img src=x onerror="alert(1)">' }), msg({ role: "assistant", content: "<!doctype html><html><body>full doc</body></html>" })],
      format: "html",
    });
    expect(result).not.toBeNull();
    const html = result!.content;
    // No raw script/img tag may survive into the report body.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<!doctype html><html>");
    // The escaped forms are present so the user still sees the original text.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;!doctype html&gt;");
  });

  it("html export escapes title and connection name in the document head", () => {
    const result = buildAiConversationExport({
      ...BASE,
      connectionName: "db</title><script>alert(1)</script>",
      messages: [msg({ role: "user", content: "hi" })],
      format: "html",
    });
    const html = result!.content;
    expect(html).toContain("<title>db&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; · AI Analysis</title>");
    expect(html).not.toContain("<script>alert(1)");
    // `<>/"` become underscores (same rule as every export file name); trailing underscores are trimmed.
    expect(result!.defaultFileName).toMatch(/^db__title__script_alert\(1\)__script_\d{12}\.html$/);
  });

  it("html export carries the shared preview CSP and renders fences as escaped code blocks", () => {
    const result = buildAiConversationExport({
      ...BASE,
      messages: [msg({ role: "assistant", content: "```html\n<b>hi</b>\n```" }), msg({ role: "assistant", content: "see ![pic](https://example.invalid/x.png)" })],
      format: "html",
    });
    const html = result!.content;
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    // The ```html fence body is escaped text inside a code block, never live markup.
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<b>hi</b>");
    expect(result!.defaultFileName).toMatch(/\.html$/);
  });

  it("html export labels roles and marks failed replies", () => {
    const result = buildAiConversationExport({
      ...BASE,
      messages: [msg({ role: "user", content: "q" }), msg({ role: "assistant", content: "AI request failed", failed: true })],
      format: "html",
    });
    const html = result!.content;
    expect(html).toContain('<article class="user">');
    expect(html).toContain('<article class="assistant">');
    expect(html).toContain(`<p class="role">User</p>`);
    expect(html).toContain(`<p class="failed">${LABELS.failedLabel}</p>`);
  });

  it("sanitizes the connection name for the file name while keeping the display name", () => {
    const result = buildAiConversationExport({
      ...BASE,
      connectionName: 'prod:<db>"*?"',
      messages: [msg({ role: "user", content: "hi" })],
      format: "markdown",
    });
    expect(result!.content).toContain('# prod:<db>"*?" · AI Analysis');
    // `<>:"*?` become underscores; the trailing run of underscores is trimmed.
    expect(result!.defaultFileName).toMatch(/^prod__db_\d{12}\.md$/);
  });

  it("falls back to the ai prefix when no connection name is given", () => {
    const result = buildAiConversationExport({
      ...BASE,
      connectionName: undefined,
      messages: [msg({ role: "user", content: "hi" })],
      format: "markdown",
    });
    expect(result!.defaultFileName).toMatch(/^ai_\d{12}\.md$/);
    expect(result!.content).toContain("# AI · AI Analysis");
  });
});
