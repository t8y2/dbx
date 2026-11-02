// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLegacyWebViewClass, isBlockingCompatFailure, isLegacyWebView, LEGACY_WEBVIEW_CLASS, missingLegacyWebViewCapabilities, supportsRegExpLookbehind, webViewCompatReport } from "@/lib/ui/legacyWebView";

const supportedFeatures = new Set(["oklch", "color-mix-oklab", "color-mix-oklch", "has-selector", "dynamic-viewport", "min-function", "media-query-range"]);

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
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width >= 0px)" ? features.has("media-query-range") : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
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
    expect(missingLegacyWebViewCapabilities()).toEqual(["color-mix-oklab", "color-mix-oklch", "has-selector", "dynamic-viewport", "min-function", "media-query-range"]);
  });

  it("does not treat one color-mix interpolation space as the other", () => {
    mockCssSupports(new Set(["oklch", "color-mix-oklab", "has-selector", "dynamic-viewport", "min-function"]));

    expect(isLegacyWebView()).toBe(true);
    expect(missingLegacyWebViewCapabilities()).toEqual(["color-mix-oklch", "media-query-range"]);
  });

  it("marks a WebView without media query range syntax as legacy", () => {
    mockCssSupports(new Set(["oklch", "color-mix-oklab", "color-mix-oklch", "has-selector", "dynamic-viewport", "min-function"]));

    expect(isLegacyWebView()).toBe(true);
    expect(missingLegacyWebViewCapabilities()).toEqual(["media-query-range"]);
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

describe("inline engine probe report", () => {
  const setReport = (report: unknown) => {
    (window as unknown as Record<string, unknown>).__DBX_WEBVIEW_COMPAT__ = report;
  };

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__DBX_WEBVIEW_COMPAT__;
  });

  it("prefers the verdict the probe recorded before the bundle loaded", () => {
    setReport({ tier: "fatal", missing: ["layer"], engine: "Safari 15.2", platform: "macos", desktop: true, bypassed: false });

    expect(webViewCompatReport()?.engine).toBe("Safari 15.2");
    expect(isLegacyWebView()).toBe(true);
    expect(missingLegacyWebViewCapabilities()).toEqual(["layer"]);
  });

  it("treats a clean report as a supported engine", () => {
    setReport({ tier: "ok", missing: [], engine: "Safari 17.6", platform: "macos", desktop: true, bypassed: false });

    expect(isLegacyWebView()).toBe(false);
    expect(missingLegacyWebViewCapabilities()).toEqual([]);
  });

  it("ignores a malformed report and falls back to probing", () => {
    mockCssSupports(supportedFeatures);
    setReport({ tier: "ok" });

    expect(webViewCompatReport()).toBeUndefined();
    expect(missingLegacyWebViewCapabilities()).toEqual([]);
  });

  it("blocks startup only on a fatal engine the user did not choose to continue past", () => {
    expect(isBlockingCompatFailure()).toBe(false);

    setReport({ tier: "degraded", missing: ["media-query-range"], engine: "", platform: "web", desktop: false, bypassed: false });
    expect(isBlockingCompatFailure()).toBe(false);

    setReport({ tier: "fatal", missing: ["layer"], engine: "", platform: "macos", desktop: true, bypassed: false });
    expect(isBlockingCompatFailure()).toBe(true);

    setReport({ tier: "fatal", missing: ["layer"], engine: "", platform: "macos", desktop: true, bypassed: true });
    expect(isBlockingCompatFailure()).toBe(false);
  });
});

describe("supportsRegExpLookbehind", () => {
  it("reports support when the engine compiles lookbehind patterns", () => {
    expect(supportsRegExpLookbehind()).toBe(true);
  });

  it("reports no support when lookbehind patterns throw like old WebKit", () => {
    const OriginalRegExp = RegExp;
    vi.stubGlobal(
      "RegExp",
      class extends OriginalRegExp {
        constructor(pattern: string | RegExp, flags?: string) {
          if (typeof pattern === "string" && pattern.includes("(?<")) {
            throw new SyntaxError("Invalid regular expression: invalid group specifier name");
          }
          super(pattern, flags);
        }
      },
    );

    expect(supportsRegExpLookbehind()).toBe(false);
  });
});
