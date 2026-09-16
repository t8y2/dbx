import { describe, expect, it } from "vitest";
import { renderNote } from "../renderNote";

describe("renderNote", () => {
  it("renders ordinary markdown", () => {
    expect(renderNote("One row per **checkout**.")).toContain("<strong>checkout</strong>");
  });

  it("renders inline code and fenced blocks", () => {
    expect(renderNote("see `order_status`")).toContain("<code>order_status</code>");
    expect(renderNote("```sql\nSELECT 1;\n```")).toContain("<pre>");
  });

  it("returns an empty string for null or blank input", () => {
    expect(renderNote(null)).toBe("");
    expect(renderNote("   ")).toBe("");
  });

  it("escapes a script tag rather than rendering it", () => {
    const html = renderNote("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an img onerror payload", () => {
    // NB: asserting !contains("onerror=") would FAIL against a correct
    // implementation — the escaped text legitimately still contains that
    // substring. What matters is that no <img> ELEMENT is produced.
    const html = renderNote('<img src=x onerror="alert(1)">');
    expect(html.toLowerCase()).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes raw HTML even when it looks harmless", () => {
    // Blanket rule: no author-supplied HTML is rendered, ever. A rule with
    // exceptions is a rule someone will find a way around.
    const html = renderNote("<b>bold</b>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("does not preserve HTML entities twice", () => {
    // Guards the pre-escaping approach, which turns "a &amp; b" into
    // "a &amp;amp; b" and renders the entity visibly to the reader.
    expect(renderNote("a &amp; b")).toContain("a &amp; b");
    expect(renderNote("a &amp; b")).not.toContain("&amp;amp;");
  });

  it.each([
    ["javascript:alert(1)", "javascript"],
    ["JaVaScRiPt:alert(1)", "javascript"],
    ["&#106;avascript:alert(1)", "avascript"],
    ["vbscript:alert(1)", "vbscript"],
    ["data:text/html;base64,PHNjcmlwdD4=", "data:"],
  ])("drops the unsafe link scheme %s", (href, forbidden) => {
    const html = renderNote(`[click](${href})`).toLowerCase();
    expect(html).not.toContain(forbidden);
    expect(html).toContain("click"); // the text survives; only the href is dropped
  });

  it("drops an unsafe image scheme", () => {
    const html = renderNote("![img](javascript:alert(1))").toLowerCase();
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("<img");
  });

  it.each(["//evil.example.com", "//evil.example.com/a.png", "/\\evil.example.com", "/\\evil.example.com/a.png", "\\\\evil.example.com"])("drops the protocol-relative URL %s", (href) => {
    // The URL spec treats /\ like //, so both separators must be rejected.
    expect(renderNote(`[x](${href})`)).not.toContain("evil.example.com");
    expect(renderNote(`![x](${href})`)).not.toContain("evil.example.com");
  });

  it("escapes single quotes so the escaper does not rely on double-quoted attributes", () => {
    // Not exploitable while every attribute here is double-quoted, but that is
    // a formatting convention enforced nowhere. Escaping ' keeps escapeHtml
    // correct on its own rather than correct-given-a-distant-invariant.
    const html = renderNote(`[x](https://example.com "it's here")`);
    expect(html).toContain("&#39;");
    expect(html).not.toContain("it's here");
  });

  it("still allows an ordinary root-relative path", () => {
    // The // guard must not break the single-slash relative case it sits in
    // front of.
    expect(renderNote("[x](/docs/page.html)")).toContain('href="/docs/page.html"');
  });

  it.each(["https://example.com", "http://example.com", "mailto:a@b.com", "#anchor", "./rel.html"])("keeps the safe link target %s", (href) => {
    expect(renderNote(`[ok](${href})`)).toContain(`href="${href}"`);
  });

  it("parses markdown inside link text instead of emitting it raw", () => {
    // marked hands the renderer the RAW source text. Emitting it directly
    // both breaks formatting and injects unescaped HTML.
    expect(renderNote("[**keep**](https://example.com)")).toContain("<strong>keep</strong>");
    const dropped = renderNote('[<img src=x onerror="alert(1)">](javascript:alert(1))');
    expect(dropped.toLowerCase()).not.toContain("<img");
    expect(dropped).toContain("&lt;img");
  });
});
