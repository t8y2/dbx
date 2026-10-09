export const LEGACY_WEBVIEW_CLASS = "dbx-legacy-webview";

/**
 * Verdict recorded by the inline probe in index.html, which runs before this bundle loads.
 * Reading it keeps a single source of truth, so the "upgrade your engine" notice and the
 * `dbx-legacy-webview` fallback layer can never disagree. Unlike the probes below, the inline
 * one also covers `@layer`, which is what decides whether the shell can be styled at all.
 */
export type WebViewCompatTier = "ok" | "degraded" | "fatal";

export interface WebViewCompatReport {
  tier: WebViewCompatTier;
  missing: string[];
  engine: string;
  platform: string;
  desktop: boolean;
  bypassed: boolean;
}

declare global {
  interface Window {
    __DBX_WEBVIEW_COMPAT__?: WebViewCompatReport;
  }
}

type CssSupportCheck = {
  name: string;
  property?: string;
  value?: string;
  condition?: string;
  test?: () => boolean;
};

const MODERN_CSS_FEATURES: CssSupportCheck[] = [
  { name: "oklch", property: "color", value: "oklch(0.5 0.1 180)" },
  { name: "color-mix-oklab", property: "background-color", value: "color-mix(in oklab, black 10%, transparent)" },
  { name: "color-mix-oklch", property: "background-color", value: "color-mix(in oklch, black 10%, transparent)" },
  { name: "has-selector", condition: "selector(:has(*))" },
  { name: "dynamic-viewport", property: "height", value: "100dvh" },
  { name: "min-function", property: "width", value: "min(100%, 1px)" },
  {
    name: "media-query-range",
    test: () => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
      try {
        return window.matchMedia("(width >= 0px)").matches;
      } catch {
        return false;
      }
    },
  },
];

function supports(check: CssSupportCheck): boolean {
  if (check.test) return check.test();
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;

  try {
    return check.condition ? CSS.supports(check.condition) : CSS.supports(check.property!, check.value!);
  } catch {
    return false;
  }
}

export function webViewCompatReport(): WebViewCompatReport | undefined {
  if (typeof window === "undefined") return undefined;
  const report = window.__DBX_WEBVIEW_COMPAT__;
  if (!report || typeof report.tier !== "string" || !Array.isArray(report.missing)) return undefined;
  return report;
}

export function missingLegacyWebViewCapabilities(): string[] {
  const report = webViewCompatReport();
  if (report) return [...report.missing];

  return MODERN_CSS_FEATURES.filter((feature) => !supports(feature)).map((feature) => feature.name);
}

/**
 * True when the startup notice is blocking the app: the engine drops the whole layered
 * stylesheet, so mounting the shell would replace a readable message with an unstyled UI.
 * A user who chose "continue anyway" is not blocked again until the next session.
 */
export function isBlockingCompatFailure(): boolean {
  const report = webViewCompatReport();
  return report?.tier === "fatal" && report.bypassed !== true;
}

/**
 * Old WebKit (Safari < 16.4) throws SyntaxError when compiling regular
 * expressions with lookbehind or the named-group shapes Shiki's JavaScript
 * engine generates from TextMate grammars. Callers use this to pick a regex
 * engine (e.g. Shiki's Oniguruma WASM engine) that old WebKit can run.
 *
 * The pattern below is the only permitted lookbehind in bundled sources: it
 * is constructed inside a try/catch at call time (not at module parse time),
 * so the engine that cannot compile it is exactly the one being detected.
 * legacyWebViewRegexCompat.spec.ts allows this file by name.
 */
export function supportsRegExpLookbehind(): boolean {
  try {
    // Probe compiled from a string so this module still parses on old WebKit.
    new RegExp("(?<=a)b");
    return true;
  } catch {
    return false;
  }
}

export function isLegacyWebView(): boolean {
  return missingLegacyWebViewCapabilities().length > 0;
}

export function applyLegacyWebViewClass(root: Element = document.documentElement): boolean {
  const legacy = isLegacyWebView();
  root.classList.toggle(LEGACY_WEBVIEW_CLASS, legacy);
  return legacy;
}
