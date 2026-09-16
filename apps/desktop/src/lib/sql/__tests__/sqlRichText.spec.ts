import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/common/clipboard", () => ({
  copyRichTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { copyRichTextToClipboard } from "@/lib/common/clipboard";
import { copySqlAsRichText, renderSqlRichTextHtml } from "@/lib/sql/sqlRichText";

describe("renderSqlRichTextHtml", () => {
  it("emits token colors as inline styles inside a single pre", async () => {
    const html = await renderSqlRichTextHtml("SELECT id FROM users;");

    expect(html.startsWith('<pre style="')).toBe(true);
    expect(html.endsWith("</pre>")).toBe(true);
    expect(html).toContain('<span style="color:');
    expect(html).toContain("SELECT");
    expect(html).toContain("users");
  });

  it("carries no class attributes or style blocks that mail clients would strip", async () => {
    const html = await renderSqlRichTextHtml("SELECT id FROM users WHERE name = 'ada';");

    expect(html).not.toContain("class=");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<code");
  });

  it("declares a monospace font and light colors on the pre itself", async () => {
    const html = await renderSqlRichTextHtml("SELECT 1;");
    const preStyle = html.slice(0, html.indexOf(">"));

    expect(preStyle).toContain("font-family:");
    expect(preStyle).toContain("monospace");
    expect(preStyle).toContain("white-space:pre");
    expect(preStyle).toContain("background-color:#ffffff");
  });

  it("escapes html-sensitive characters from the source", async () => {
    const html = await renderSqlRichTextHtml("SELECT '<b>&</b>';");

    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
  });

  it("keeps one newline per source line break so indentation survives the paste", async () => {
    const html = await renderSqlRichTextHtml("SELECT a,\n       b\nFROM t;");

    expect(html.match(/\n/g)).toHaveLength(2);
    expect(html).toContain("       b");
  });

  it("falls back to uncolored markup for sources too large to tokenize", async () => {
    const html = await renderSqlRichTextHtml("SELECT 1;\n".repeat(25_000));

    expect(html.startsWith('<pre style="')).toBe(true);
    expect(html).not.toContain('<span style="color:');
  });
});

describe("copySqlAsRichText", () => {
  it("writes the highlighted html alongside the untouched plain text", async () => {
    const sql = "SELECT id FROM users;";

    await copySqlAsRichText(sql);

    expect(copyRichTextToClipboard).toHaveBeenCalledTimes(1);
    const [html, text] = vi.mocked(copyRichTextToClipboard).mock.calls[0]!;
    expect(text).toBe(sql);
    expect(html).toContain('<span style="color:');
    expect(html).toContain("SELECT");
  });
});
