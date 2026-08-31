import { describe, expect, it, vi } from "vitest";
import { createSafeSqlHighlighter, escapeHtml } from "@/lib/sql/sqlHighlighter";

describe("escapeHtml", () => {
  it("escapes SQL text for v-html fallback rendering", () => {
    expect(escapeHtml(`SELECT '<tag>' AS "name" & col`)).toBe("SELECT &#39;&lt;tag&gt;&#39; AS &quot;name&quot; &amp; col");
  });
});

describe("createSafeSqlHighlighter", () => {
  it("keeps the default GitHub themes", () => {
    const codeToHtml = vi.fn(() => "<span>SELECT 1</span>");
    const highlighter = createSafeSqlHighlighter({ codeToHtml }, { appearance: () => "light" });

    expect(highlighter("SELECT 1")).toBe("<span>SELECT 1</span>");
    expect(highlighter("SELECT 2", "dark")).toBe("<span>SELECT 1</span>");
    expect(codeToHtml).toHaveBeenNthCalledWith(1, "SELECT 1", {
      lang: "sql",
      structure: "inline",
      theme: "github-light",
    });
    expect(codeToHtml).toHaveBeenNthCalledWith(2, "SELECT 2", {
      lang: "sql",
      structure: "inline",
      theme: "github-dark",
    });
  });

  it("uses the existing SQL preview themes", () => {
    const codeToHtml = vi.fn(() => "<span>SELECT 1</span>");
    const highlighter = createSafeSqlHighlighter(
      { codeToHtml },
      {
        appearance: () => "light",
        themePreset: "preview",
      },
    );

    highlighter("SELECT 1");
    highlighter("SELECT 2", "dark");

    expect(codeToHtml).toHaveBeenNthCalledWith(1, "SELECT 1", {
      lang: "sql",
      structure: "inline",
      theme: "min-light",
    });
    expect(codeToHtml).toHaveBeenNthCalledWith(2, "SELECT 2", {
      lang: "sql",
      structure: "inline",
      theme: "dark-plus",
    });
  });

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
