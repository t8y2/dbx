import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

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
});
