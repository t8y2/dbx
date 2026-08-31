import { describe, expect, it } from "vitest";
import { createAiShikiBlockCodeHighlighter } from "@/lib/ai/aiCodeHighlighter";

describe("createAiShikiBlockCodeHighlighter", () => {
  it("wraps every source line in its own .line span with no stray connecting newline", async () => {
    const highlight = await createAiShikiBlockCodeHighlighter({ appearance: () => "light" });

    const html = highlight("SELECT\n    id,\n        name\nFROM users", "sql");

    expect(html.match(/class="line"/g)).toHaveLength(4);
    // Issue #6894: shiki's classic structure joins lines with a literal "\n" text
    // node; since `.line` is already `display:block`, leaving that in doubles the
    // visual line spacing under `white-space:pre`. It must be stripped.
    expect(html).not.toMatch(/<\/span>\n/);
    // Leading indentation must survive (it's rendered as a plain text token).
    expect(html).toContain("    id,");
    expect(html).toContain("        name");
  });

  it("does not leak shiki's own <pre>/<code> wrapper (the caller supplies its own)", async () => {
    const highlight = await createAiShikiBlockCodeHighlighter({ appearance: () => "dark" });

    const html = highlight("SELECT 1", "sql");

    expect(html).not.toContain("<pre");
    expect(html).not.toContain("<code");
  });

  it("can build the oniguruma WASM engine used on legacy WebViews", async () => {
    // Mirrors the exact wiring loadAiShikiHighlighter uses on WebKit engines
    // that cannot compile the JavaScript engine's lookbehind patterns, so a
    // broken shiki/wasm integration fails here instead of on a packaged app.
    const [{ createHighlighterCore }, { createOnigurumaEngine }, { default: sql }, { default: githubLight }] = await Promise.all([import("shiki/core"), import("shiki/engine/oniguruma"), import("shiki/langs/sql.mjs"), import("shiki/themes/github-light.mjs")]);
    const highlighter = await createHighlighterCore({
      engine: await createOnigurumaEngine(import("shiki/wasm")),
      langs: [sql],
      themes: [githubLight],
    });

    const html = highlighter.codeToHtml("SELECT id FROM users", { lang: "sql", structure: "classic", theme: "github-light" });

    expect(html).toContain('class="line"');
    expect(html).toMatch(/style="color:#/);
  }, 30_000);
});
