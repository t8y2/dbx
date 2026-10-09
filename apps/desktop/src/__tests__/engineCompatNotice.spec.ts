// The compatibility notice in index.html has to render on engines whose entire `@layer` output
// is discarded, so its styling and its probe order are load-bearing and easy to break by
// accident. These assertions pin the parts a browser test cannot: that the notice runs before
// the bundle, that it never depends on anything the broken engine would drop, and that the copy
// still tells each kind of user how to fix it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

function probeScriptSource(): string {
  const start = indexHtml.indexOf("<script data-dbx-compat-probe>");
  expect(start).toBeGreaterThan(-1);
  return indexHtml.slice(start, indexHtml.indexOf("</script>", start));
}

describe("engine compatibility notice", () => {
  const script = probeScriptSource();

  it("runs before the app bundle so a broken shell is never painted first", () => {
    expect(indexHtml.indexOf("data-dbx-compat-probe")).toBeLessThan(indexHtml.indexOf('src="/src/main.ts"'));
  });

  it("styles the notice with inline styles only", () => {
    // `@layer` blocks are dropped wholesale by the engines this notice targets, and the design
    // tokens live in `@layer theme`. Production CSS also rewrites `min-width` media queries into
    // range syntax those engines cannot parse. Inline styles avoid all three hazards.
    expect(script).toContain("style.cssText");
    expect(script).not.toContain("var(--");
    expect(script).not.toContain("@media");
  });

  it("probes every capability the layered stylesheet depends on", () => {
    for (const probe of ["layer", "oklch", "color-mix", "media-query-range", "has-selector", "focus-visible"]) {
      expect(script).toContain(`["${probe}"`);
    }
  });

  it("separates a blocking failure from a degraded one", () => {
    expect(script).toContain("FATAL_PROBES");
    expect(script).toContain("DEGRADED_PROBES");
    // Only a missing @layer discards the stylesheet wholesale; engines that keep
    // @layer but lack the color functions still render and get the banner tier.
    // This keeps fixed Chromium-109-based webview builds below the blocking gate.
    expect(script).toContain('missingFatal.includes("layer")');
    expect(script).toContain('const missingColors = missingFatal.filter((name) => name !== "layer");');
    expect(script).toContain("missingColors.length || missingDegraded.length");
  });

  it("fails open when the probe itself throws", () => {
    expect(script).toContain("catch (error)");
    expect(script).toContain('report.tier = "ok";');
  });

  it("publishes the verdict for the bundle and for support", () => {
    expect(script).toContain("window.__DBX_WEBVIEW_COMPAT__ = report");
    expect(script).toContain('"dbx-compat"');
    expect(script).toContain("dbx-compat-bypass");
  });

  it("routes each audience to the upgrade that actually fixes it", () => {
    // Desktop users cannot update a browser, and browser users cannot update WebKit.
    expect(script).toContain("12.7.6");
    expect(script).toContain("Safari 17.6");
    expect(script).toContain("Chrome、Edge、Firefox、Safari");
    expect(script).toContain("Update your browser to the latest version");
  });

  it("names the thing to upgrade in the degraded banner", () => {
    // "建议升级后使用" was ambiguous: upgrade DBX, macOS, or Safari?
    expect(script).not.toContain("建议升级后使用");
    for (const key of ["macBanner", "desktopBanner", "webBanner"]) {
      // Every language carries its own copy, and the picker chooses between them.
      expect(script.split(key + ":").length - 1).toBe(3);
    }
    expect(script).toContain("const bannerText = mac ? copy.macBanner : report.desktop ? copy.desktopBanner : copy.webBanner;");
  });

  it("records the verdict for support and keeps the two notices independent", () => {
    expect(script).toContain('document.documentElement.setAttribute("data-dbx-compat", report.tier)');
    expect(script).toContain('report.tier !== "ok" && !report.bypassed');
    // Dismissing the advisory banner must not silence the blocking gate.
    expect(script).toContain('const dismissedDegraded = report.tier === "degraded" && storage("localStorage", BANNER_KEY) === "1"');
    expect(script).toContain("!report.bypassed && !dismissedDegraded");
  });
});
