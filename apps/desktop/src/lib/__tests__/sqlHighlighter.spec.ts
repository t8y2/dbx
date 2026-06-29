import { describe, expect, it, vi } from "vitest";
import { createSafeSqlHighlighter, escapeHtml } from "@/lib/sqlHighlighter";

describe("escapeHtml", () => {
  it("escapes SQL text for v-html fallback rendering", () => {
    expect(escapeHtml(`SELECT '<tag>' AS "name" & col`)).toBe("SELECT &#39;&lt;tag&gt;&#39; AS &quot;name&quot; &amp; col");
  });
});

describe("createSafeSqlHighlighter", () => {
  it("falls back to escaped SQL when Shiki highlighting fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const highlighter = createSafeSqlHighlighter(
      {
        codeToHtml: () => {
          throw new SyntaxError("Invalid regular expression: invalid group specifier name");
        },
      },
      { appearance: () => "light" },
    );

    expect(highlighter(`ALTER TABLE t ADD "<x>" INT;`)).toBe("ALTER TABLE t ADD &quot;&lt;x&gt;&quot; INT;");
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });
});
