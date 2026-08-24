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
});
