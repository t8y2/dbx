export const LEGACY_WEBVIEW_CLASS = "dbx-legacy-webview";

type CssSupportCheck = {
  name: string;
  property?: string;
  value?: string;
  condition?: string;
};

const MODERN_CSS_FEATURES: CssSupportCheck[] = [
  { name: "oklch", property: "color", value: "oklch(0.5 0.1 180)" },
  { name: "color-mix-oklab", property: "background-color", value: "color-mix(in oklab, black 10%, transparent)" },
  { name: "color-mix-oklch", property: "background-color", value: "color-mix(in oklch, black 10%, transparent)" },
  { name: "has-selector", condition: "selector(:has(*))" },
  { name: "dynamic-viewport", property: "height", value: "100dvh" },
  { name: "min-function", property: "width", value: "min(100%, 1px)" },
];

function supports(check: CssSupportCheck): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;

  try {
    return check.condition ? CSS.supports(check.condition) : CSS.supports(check.property!, check.value!);
  } catch {
    return false;
  }
}

export function missingLegacyWebViewCapabilities(): string[] {
  return MODERN_CSS_FEATURES.filter((feature) => !supports(feature)).map((feature) => feature.name);
}

export function isLegacyWebView(): boolean {
  return missingLegacyWebViewCapabilities().length > 0;
}

export function applyLegacyWebViewClass(root: Element = document.documentElement): boolean {
  const legacy = isLegacyWebView();
  root.classList.toggle(LEGACY_WEBVIEW_CLASS, legacy);
  return legacy;
}
