import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_HTML_PREVIEW_CSP, buildSafeHtmlPreview } from "@/lib/ai/richContent/aiHtmlPreview";

// The canary payload tries every escape the PRD requires evidence for: inline
// script, remote image, fetch, form submit, and <base> rewriting. It must
// survive verbatim into the wrapped document (a canary that was stripped proves
// nothing) — the CSP shell, not content filtering, is what neutralizes it.
const canaryVectors = [
  '<script>document.title = "SCRIPT-RAN"; document.body.style.background = "red"; fetch("https://canary.invalid/fetch");</script>',
  '<img src="https://canary.invalid/remote.png" alt="remote">',
  '<img src="https://canary.invalid/onerror.png" onerror="document.title = \'ONERROR-RAN\'" alt="onerror">',
  '<form action="https://canary.invalid/submit"><input type="submit" value="submit"></form>',
  '<base href="https://canary.invalid/">',
  '<a href="relative.png">relative link</a>',
  // The relative <img> fires an auto-load with no click required: if `base-uri
  // 'none'` failed, <base href> would rewrite it to
  // https://canary.invalid/relative.png and the netlog would expose the leak
  // without manual interaction.
  '<img src="relative.png" alt="relative">',
  // Visible only when scripting is DISABLED (context A): a green PASS marker.
  '<noscript><p style="color:green;margin:0;font:600 13px system-ui">scripts are blocked → PASS</p></noscript>',
].join("\n");

// Navigation canary — deliberately NOT in canaryVectors: every vector above
// must survive verbatim (a stripped canary proves nothing), but no CSP fetch
// directive governs navigation and `sandbox=""` only gates top-navigation and
// popups, so a sandboxed iframe can still navigate itself. The refresh meta is
// the one vector the wrapper itself must defuse before it reaches either
// context; a zero-click `<meta refresh>` is an automatic outbound beacon.
const metaRefreshCanary = '<meta http-equiv="refresh" content="0;url=https://canary.invalid/">';

const componentSource = readFileSync(new URL("../../../../components/ai/rich/AiHtmlPreview.vue", import.meta.url), "utf8");

describe("AiHtmlPreview sandbox hardening (static canary)", () => {
  it("sandboxes every preview iframe without any escape hatch", () => {
    // Inspect every actual iframe tag, not the whole source (comments mention the
    // sandbox tokens by name when documenting why they are absent). The inline
    // card and the expanded dialog iframes must carry identical boundaries.
    const iframeTags = componentSource.match(/<iframe[^>]*>/g) ?? [];
    expect(iframeTags.length).toBeGreaterThanOrEqual(2);
    for (const iframeTag of iframeTags) {
      expect(iframeTag).toContain('sandbox=""');
      for (const forbidden of ["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups", "allow-modals", "allow-top-navigation"]) {
        expect(iframeTag).not.toContain(forbidden);
      }
    }
  });

  it("renders the wrapped shell, never the raw source, as the iframe payload", () => {
    expect(componentSource).toContain(':srcdoc="document"');
    // The component has no path to inject `content` into the DOM itself.
    expect(componentSource).not.toContain('v-html="content"');
  });

  it("keeps the canary vectors present in the wrapped document while the CSP neutralizes each", () => {
    const wrapped = buildSafeHtmlPreview(canaryVectors);
    // Every vector is still in the payload — nothing was stripped or rewritten.
    for (const vector of canaryVectors.split("\n")) {
      expect(wrapped).toContain(vector);
    }
    const position = (needle: string) => wrapped.indexOf(needle);
    // The CSP meta precedes every vector: the policy applies document-wide.
    for (const vector of canaryVectors.split("\n")) {
      expect(position("Content-Security-Policy")).toBeLessThan(position(vector));
    }
    // Vector → neutralizer mapping (per the PRD's canary matrix):
    // inline/`onerror=` scripts and `fetch()` → no script-src grant, blocked by default-src 'none'
    expect(AI_HTML_PREVIEW_CSP).toContain("default-src 'none'");
    expect(AI_HTML_PREVIEW_CSP).not.toContain("script-src");
    // remote img → img-src limited to data:/blob:
    expect(AI_HTML_PREVIEW_CSP).toContain("img-src data: blob:");
    // form submit target → form-action 'none' (does NOT inherit default-src)
    expect(AI_HTML_PREVIEW_CSP).toContain("form-action 'none'");
    // <base> rewrite → base-uri 'none' (does NOT inherit default-src)
    expect(AI_HTML_PREVIEW_CSP).toContain("base-uri 'none'");
  });

  it("defuses the meta-refresh navigation canary (navigation is outside the CSP fetch model)", () => {
    const wrapped = buildSafeHtmlPreview(`${canaryVectors}\n${metaRefreshCanary}`);
    // The verbatim-survival canaries are untouched by the defusing pass...
    for (const vector of canaryVectors.split("\n")) {
      expect(wrapped).toContain(vector);
    }
    // ...while the refresh meta is swapped for an inert comment: the wrapped
    // document holds no live http-equiv=refresh in any spelling.
    expect(wrapped).not.toContain(metaRefreshCanary);
    expect(wrapped).toContain("<!-- meta refresh removed -->");
    expect(wrapped).not.toMatch(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b/i);
  });

  it("writes a manual WebView canary harness when AI_HTML_CANARY_OUT is set", () => {
    const outPath = process.env.AI_HTML_CANARY_OUT;
    if (!outPath) {
      // Regenerate on demand: AI_HTML_CANARY_OUT=<path> pnpm vitest run <this file>
      return;
    }
    const wrapped = buildSafeHtmlPreview(`${canaryVectors}\n${metaRefreshCanary}`);
    // The visible PASS marker inside the sandbox: `noscript` renders only when
    // scripting is disabled — i.e. exactly when the sandbox held.
    const harness = [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8"><title>AI HTML preview runtime canary</title>',
      "<style>body{font-family:system-ui;max-width:60rem;margin:2rem auto;padding:0 1rem;line-height:1.5}",
      "iframe{width:100%;height:16rem;border:2px solid #888;background:#fff}",
      "li{margin:.25rem 0}code{background:#f2f2f2;padding:0 .3rem}</style></head><body>",
      "<h1>AI HTML preview runtime canary</h1>",
      "<p>This harness embeds the exact bytes <code>buildSafeHtmlPreview</code> produces (the same payload “Save Safe HTML” writes). Open it in the app WebView (dev build) and in a regular browser. All checks must show <b>PASS</b> and the network panel must stay empty.</p>",
      "<h2>Context A — iframe preview (sandbox=&quot;&quot;)</h2>",
      `<iframe sandbox="" srcdoc="${wrapped.replace(/"/g, "&quot;")}"></iframe>`,
      "<h2>Context B — saved standalone file</h2>",
      "<p>Click “Download wrapped file”, then open the downloaded copy directly in the WebView/browser: outside the sandbox, the CSP meta alone must hold.</p>",
      // `<\/` keeps the canary's own `</script>` from terminating this harness script.
      `<script>const blob = new Blob([${JSON.stringify(wrapped).replace(/<\//g, "<\\/")}], {type: "text/html"});const a = document.createElement("a");a.href = URL.createObjectURL(blob);a.download = "ai-html-canary-wrapped.html";a.textContent = "Download wrapped file";document.body.appendChild(a);</script>`,
      "<h2>Checklist (both contexts)</h2><ul>",
      "<li><b>Script:</b> the area stays WHITE — a red background or <code>SCRIPT-RAN</code> title means FAIL. Inside context A a green “scripts are blocked → PASS” note is visible (that is <code>&lt;noscript&gt;</code> rendering).</li>",
      "<li><b>Remote image:</b> both canary <code>&lt;img&gt;</code> elements render as broken-image placeholders, never loaded (DevTools network: no request to <code>canary.invalid</code>).</li>",
      "<li><b>fetch:</b> no network request to <code>canary.invalid</code>.</li>",
      "<li><b>Form:</b> submitting the canary form does nothing — no navigation to <code>canary.invalid</code>.</li>",
      "<li><b>Base rewrite:</b> the “relative link” does not resolve to <code>canary.invalid/relative.png</code>.</li>",
      "<li><b>Meta refresh:</b> the document does not navigate away on its own — the canary refresh meta must appear only as the inert <code>&lt;!-- meta refresh removed --&gt;</code> comment.</li>",
      "</ul></body></html>",
    ].join("\n");
    writeFileSync(outPath, harness, "utf8");
    expect(readFileSync(outPath, "utf8")).toContain('sandbox=""');
  });
});
