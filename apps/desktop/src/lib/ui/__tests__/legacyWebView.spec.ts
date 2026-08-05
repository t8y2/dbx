// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLegacyWebViewClass, isLegacyWebView, LEGACY_WEBVIEW_CLASS, missingLegacyWebViewCapabilities } from "@/lib/ui/legacyWebView";

const supportedFeatures = new Set(["oklch", "color-mix-oklab", "color-mix-oklch", "has-selector", "dynamic-viewport", "min-function"]);

function mockCssSupports(features: Set<string>) {
  vi.stubGlobal("CSS", {
    supports: (propertyOrCondition: string, value?: string) => {
      const key =
        value === undefined
          ? propertyOrCondition === "selector(:has(*))"
            ? "has-selector"
            : propertyOrCondition
          : propertyOrCondition === "color"
            ? "oklch"
            : propertyOrCondition === "background-color"
              ? value?.includes("oklab")
                ? "color-mix-oklab"
                : "color-mix-oklch"
              : propertyOrCondition === "height"
                ? "dynamic-viewport"
                : propertyOrCondition === "width"
                  ? "min-function"
                  : "";
      return features.has(key);
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("legacy WebView detection", () => {
  it("accepts a WebView with the CSS capabilities used by Tailwind v4 fallbacks", () => {
    mockCssSupports(supportedFeatures);

    expect(isLegacyWebView()).toBe(false);
    expect(missingLegacyWebViewCapabilities()).toEqual([]);
  });

  it("marks a partial WebView as legacy when any required capability is missing", () => {
    mockCssSupports(new Set(["oklch"]));

    expect(isLegacyWebView()).toBe(true);
    expect(missingLegacyWebViewCapabilities()).toEqual(["color-mix-oklab", "color-mix-oklch", "has-selector", "dynamic-viewport", "min-function"]);
  });

  it("does not treat one color-mix interpolation space as the other", () => {
    mockCssSupports(new Set(["oklch", "color-mix-oklab", "has-selector", "dynamic-viewport", "min-function"]));

    expect(isLegacyWebView()).toBe(true);
    expect(missingLegacyWebViewCapabilities()).toEqual(["color-mix-oklch"]);
  });

  it("adds and removes the root class idempotently", () => {
    const root = document.createElement("html");
    mockCssSupports(new Set(["oklch"]));

    expect(applyLegacyWebViewClass(root)).toBe(true);
    expect(root.classList.contains(LEGACY_WEBVIEW_CLASS)).toBe(true);

    mockCssSupports(supportedFeatures);
    expect(applyLegacyWebViewClass(root)).toBe(false);
    expect(root.classList.contains(LEGACY_WEBVIEW_CLASS)).toBe(false);
  });
});
