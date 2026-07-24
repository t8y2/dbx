import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
const dialogContentSource = readFileSync(new URL("../../components/ui/dialog/DialogContent.vue", import.meta.url), "utf8");
const dialogScrollContentSource = readFileSync(new URL("../../components/ui/dialog/DialogScrollContent.vue", import.meta.url), "utf8");
const connectionDialogSource = readFileSync(new URL("../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("legacy WebView CSS fallbacks", () => {
  it("scopes component overrides to WebViews without OKLCH support", () => {
    const fallbackStart = globalsCss.indexOf("@supports not (color: oklch(0.5 0.1 180))");
    const tabsOverride = globalsCss.indexOf('[data-slot="tabs-trigger"]');
    const splitpanesStart = globalsCss.indexOf("/* Splitpanes */");

    expect(fallbackStart).toBeGreaterThan(-1);
    expect(tabsOverride).toBeGreaterThan(fallbackStart);
    expect(splitpanesStart).toBeGreaterThan(tabsOverride);

    let nestingDepth = 0;
    let tabsNestingDepth = 0;
    for (let index = globalsCss.indexOf("{", fallbackStart); index < splitpanesStart; index++) {
      if (globalsCss[index] === "{") nestingDepth++;
      if (globalsCss[index] === "}") nestingDepth--;
      if (index === tabsOverride) tabsNestingDepth = nestingDepth;
    }

    expect(tabsNestingDepth).toBeGreaterThan(0);
    expect(nestingDepth).toBe(0);
  });

  it("falls back to the legacy viewport height when dynamic viewport units are unavailable", () => {
    const fallback = globalsCss.indexOf("--dbx-viewport-height: 100vh;");
    const supports = globalsCss.indexOf("@supports (height: 100dvh)");
    const enhanced = globalsCss.indexOf("--dbx-viewport-height: min(100vh, 100dvh);");

    expect(fallback).toBeGreaterThan(-1);
    expect(supports).toBeGreaterThan(fallback);
    expect(enhanced).toBeGreaterThan(supports);
    expect(dialogContentSource).toContain("max-h-[calc(var(--dbx-viewport-height)-2rem)]");
    expect(dialogScrollContentSource).toContain("max-h-[calc(var(--dbx-viewport-height)-6rem)]");
    expect(connectionDialogSource).toContain("max-height: calc(var(--dbx-viewport-height) - 2rem);");
  });

  it("keeps legacy tab triggers connected to the configured corner style", () => {
    const tabsTriggerRule = globalsCss.match(/\[data-slot="tabs-trigger"\] \{([\s\S]*?)\n  \}/)?.[1];

    expect(tabsTriggerRule).toContain("border-radius: var(--dbx-radius-fixed-6);");
  });
});
