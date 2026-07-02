import { describe, expect, it } from "vitest";
import { aiMarkdownLinkUrlFromClick, formatAiInlineMarkdown, handleAiMarkdownLinkClick, normalizeAiMarkdownLink } from "@/lib/aiMarkdown";

describe("formatAiInlineMarkdown", () => {
  it("renders http links for external browser handling", () => {
    const html = formatAiInlineMarkdown("See [docs](https://example.com/a?x=1&y=2).");

    expect(html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does not render unsafe link schemes", () => {
    const html = formatAiInlineMarkdown("[run](javascript:alert(1))");

    expect(html).toContain("run");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
  });

  it("escapes raw html from assistant text", () => {
    const html = formatAiInlineMarkdown("<script>alert(1)</script>");

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("markdown table overflow wrapping", () => {
  it("wraps tables in scroll container", () => {
    const html = formatAiInlineMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");

    expect(html).toContain('<div class="ai-markdown-table-wrap">');
    expect(html).toContain("<table>");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    expect(html).toContain("<tbody>");
  });

  it("does not inject table wrapper when no table is present", () => {
    const html = formatAiInlineMarkdown("Hello **world**.");

    expect(html).not.toContain("ai-markdown-table-wrap");
    expect(html).not.toContain("<table>");
  });

  it("preserves table column alignment", () => {
    const html = formatAiInlineMarkdown("| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |");

    expect(html).toContain('align="left"');
    expect(html).toContain('align="center"');
    expect(html).toContain('align="right"');
  });

  it("handles tables with only headers", () => {
    const html = formatAiInlineMarkdown("| a | b |\n| --- | --- |");

    expect(html).toContain('<div class="ai-markdown-table-wrap">');
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).not.toContain("<td");
  });

  it("handles inline formatting inside table cells", () => {
    const html = formatAiInlineMarkdown("| a | b |\n| --- | --- |\n| **bold** | `code` |");

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code");
    expect(html).toContain("code</code>");
  });

  it("handles multi-column, multi-row tables", () => {
    const html = formatAiInlineMarkdown(["| a | b | c |", "| -- | -- | -- |", "| 1 | 2 | 3 |", "| 4 | 5 | 6 |"].join("\n"));

    expect(html).toContain('<div class="ai-markdown-table-wrap">');
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("<td>3</td>");
    expect(html).toContain("<td>4</td>");
    expect(html).toContain("<td>5</td>");
    expect(html).toContain("<td>6</td>");
  });
});

describe("normalizeAiMarkdownLink", () => {
  it("accepts absolute http and https urls", () => {
    expect(normalizeAiMarkdownLink("https://example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeAiMarkdownLink("http://example.com/docs")).toBe("http://example.com/docs");
  });

  it("rejects relative and non-browser-safe urls", () => {
    expect(normalizeAiMarkdownLink("/docs")).toBeNull();
    expect(normalizeAiMarkdownLink("mailto:test@example.com")).toBeNull();
    expect(normalizeAiMarkdownLink("javascript:alert(1)")).toBeNull();
  });
});

describe("ai markdown link clicks", () => {
  it("finds anchors from a clicked child node", () => {
    const anchor = anchorWithHref("https://example.com/docs");
    const target = { closest: (selector: string) => (selector === "a[href]" ? anchor : null) };
    const currentTarget = { contains: (node: unknown) => node === anchor };

    expect(aiMarkdownLinkUrlFromClick(target, currentTarget)).toBe("https://example.com/docs");
  });

  it("prevents default navigation and opens external links", () => {
    const anchor = anchorWithHref("https://example.com/docs");
    const target = { closest: () => anchor };
    const currentTarget = { contains: () => true };
    let prevented = false;
    let stopped = false;
    let opened = "";

    const handled = handleAiMarkdownLinkClick(
      {
        target,
        currentTarget,
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      },
      (url) => {
        opened = url;
      },
    );

    expect(handled).toBe(true);
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(opened).toBe("https://example.com/docs");
  });

  it("ignores unsafe and out-of-scope links", () => {
    const unsafeAnchor = anchorWithHref("javascript:alert(1)");
    expect(aiMarkdownLinkUrlFromClick({ closest: () => unsafeAnchor }, { contains: () => true })).toBeNull();

    const outsideAnchor = anchorWithHref("https://example.com/docs");
    expect(aiMarkdownLinkUrlFromClick({ closest: () => outsideAnchor }, { contains: () => false })).toBeNull();
  });
});

function anchorWithHref(href: string) {
  return {
    getAttribute: (name: string) => (name === "href" ? href : null),
  };
}
