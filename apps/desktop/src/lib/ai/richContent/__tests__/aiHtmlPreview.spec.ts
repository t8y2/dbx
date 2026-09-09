import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_HTML_MAX_CONTENT_CHARS, AI_HTML_PREVIEW_CSP, buildSafeHtmlPreview, isAiHtmlPreviewEligible } from "@/lib/ai/richContent/aiHtmlPreview";

describe("AI_HTML_PREVIEW_CSP", () => {
  it("declares the deny-by-default fetch directives", () => {
    expect(AI_HTML_PREVIEW_CSP).toContain("default-src 'none'");
    expect(AI_HTML_PREVIEW_CSP).toContain("img-src data: blob:");
    expect(AI_HTML_PREVIEW_CSP).toContain("style-src 'unsafe-inline'");
    expect(AI_HTML_PREVIEW_CSP).toContain("font-src data:");
  });

  it("explicitly declares the directives that do not inherit default-src", () => {
    expect(AI_HTML_PREVIEW_CSP).toContain("base-uri 'none'");
    expect(AI_HTML_PREVIEW_CSP).toContain("form-action 'none'");
  });

  it("grants no script execution whatsoever", () => {
    // No script-src: scripts fall back to default-src 'none' and are blocked.
    expect(AI_HTML_PREVIEW_CSP).not.toContain("script-src");
  });

  it("opens no network direction beyond inline data/blob payloads", () => {
    expect(AI_HTML_PREVIEW_CSP).not.toContain("http");
    expect(AI_HTML_PREVIEW_CSP).not.toContain("connect-src");
    expect(AI_HTML_PREVIEW_CSP).not.toContain("frame-src");
    expect(AI_HTML_PREVIEW_CSP).not.toContain("child-src");
  });
});

describe("buildSafeHtmlPreview", () => {
  it("wraps the raw content in a standalone document with an inline CSP", () => {
    const wrapped = buildSafeHtmlPreview("<p>hi</p>");
    expect(wrapped.startsWith("<!doctype html>")).toBe(true);
    expect(wrapped).toContain('<meta charset="utf-8">');
    expect(wrapped).toContain(`<meta http-equiv="Content-Security-Policy" content="${AI_HTML_PREVIEW_CSP}">`);
    // The CSP meta must appear before the content: it is the outer shell's
    // document-wide policy, not something the payload could place after.
    expect(wrapped.indexOf("Content-Security-Policy")).toBeLessThan(wrapped.indexOf("<p>hi</p>"));
    expect(wrapped.endsWith("</body>\n</html>")).toBe(true);
  });

  it("embeds the raw content verbatim (unescaped, sandboxing is the runtime guard)", () => {
    const hostile = `<p onclick="x()">a</p><script>fetch('https://ex.example')</script><img src="https://ex.example/i.png" onerror="x()">`;
    const wrapped = buildSafeHtmlPreview(hostile);
    expect(wrapped).toContain(hostile);
  });

  it("defuses <meta http-equiv=refresh> in any case, quoting style, or attribute order", () => {
    const vectors = [
      '<meta http-equiv="refresh" content="0;url=https://attacker/">',
      "<meta http-equiv='refresh' content='0;url=https://attacker/'>",
      "<meta http-equiv=refresh content='0;url=https://attacker/'>",
      '<meta content="0;url=https://attacker/" http-equiv="refresh">',
      '<META HTTP-EQUIV="Refresh" CONTENT="0;url=https://attacker/">',
      '<meta name="x" http-equiv="refresh" charset="utf-8" content="0;url=https://attacker/">',
      '<meta http-equiv="refresh" content="0;url=https://attacker/"/>',
    ];
    for (const vector of vectors) {
      const wrapped = buildSafeHtmlPreview(vector);
      expect(wrapped).toContain("<!-- meta refresh removed -->");
      // No live refresh meta may survive in any spelling.
      expect(wrapped).not.toMatch(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b/i);
    }
  });

  it("preserves the body around a defused refresh meta and leaves other metas untouched", () => {
    const body = '<p>before</p><meta http-equiv="refresh" content="0;url=https://attacker/"><p>after</p><meta charset="utf-8">';
    const wrapped = buildSafeHtmlPreview(body);
    expect(wrapped).toContain('<p>before</p><!-- meta refresh removed --><p>after</p><meta charset="utf-8">');
  });

  it("stays safe when the AI content is a complete HTML document", () => {
    const completeDocument = "<!DOCTYPE html><html><head><title>p</title></head><body>own</body></html>";
    const wrapped = buildSafeHtmlPreview(completeDocument);
    // Error recovery: the outer doctype/CSP meta still precede everything.
    expect(wrapped.indexOf("Content-Security-Policy")).toBeLessThan(wrapped.indexOf(completeDocument));
    expect(wrapped.startsWith("<!doctype html>")).toBe(true);
  });

  it("is deterministic so preview and saved file are byte-identical", () => {
    expect(buildSafeHtmlPreview("<b>x</b>")).toBe(buildSafeHtmlPreview("<b>x</b>"));
  });
});

describe("isAiHtmlPreviewEligible", () => {
  it("accepts bodies within the 512KB budget", () => {
    expect(isAiHtmlPreviewEligible("x")).toBe(true);
    expect(isAiHtmlPreviewEligible("x".repeat(AI_HTML_MAX_CONTENT_CHARS))).toBe(true);
  });

  it("rejects empty and over-budget bodies", () => {
    expect(isAiHtmlPreviewEligible("")).toBe(false);
    expect(isAiHtmlPreviewEligible("x".repeat(AI_HTML_MAX_CONTENT_CHARS + 1))).toBe(false);
  });
});

describe("copy-risk session state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("requires a confirmation for the first copy of a session", async () => {
    const mod = await import("@/lib/ai/richContent/aiHtmlPreview");
    expect(mod.isAiHtmlCopyRiskAcknowledged()).toBe(false);
    mod.acknowledgeAiHtmlCopyRisk();
    expect(mod.isAiHtmlCopyRiskAcknowledged()).toBe(true);
  });

  it("resets when the app session restarts (fresh module graph)", async () => {
    const first = await import("@/lib/ai/richContent/aiHtmlPreview");
    first.acknowledgeAiHtmlCopyRisk();
    vi.resetModules();
    const second = await import("@/lib/ai/richContent/aiHtmlPreview");
    expect(second.isAiHtmlCopyRiskAcknowledged()).toBe(false);
  });
});
