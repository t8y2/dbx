// The notice is the only thing a user with an unusable shell ever sees, so its behaviour matters
// as much as its copy: which engines gate, which only get a banner, how often each comes back,
// and that dismissing one can never silence the other. These tests run the real inline script from
// index.html against stubbed engine capabilities instead of asserting on its source text.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const openTag = indexHtml.indexOf("<script data-dbx-compat-probe>");
const PROBE_SOURCE = indexHtml.slice(indexHtml.indexOf(">", openTag) + 1, indexHtml.indexOf("</script>", openTag));

const SAFARI_15_2_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.2 Safari/605.1.15";
const SAFARI_16_2_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.2 Safari/605.1.15";
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type Capabilities = {
  layer: boolean;
  oklch: boolean;
  colorMix: boolean;
  mediaRange: boolean;
  has: boolean;
  focusVisible: boolean;
};

// Capability sets of the engines this notice exists for.
const SAFARI_15_2: Capabilities = { layer: false, oklch: false, colorMix: false, mediaRange: false, has: false, focusVisible: false };
const SAFARI_16_2: Capabilities = { layer: true, oklch: true, colorMix: true, mediaRange: false, has: true, focusVisible: true };
// Chromium 109: the last engine some fixed-runtime desktop builds can ever ship.
const CHROMIUM_109: Capabilities = { layer: true, oklch: false, colorMix: false, mediaRange: true, has: true, focusVisible: true };
const CHROME_120: Capabilities = { layer: true, oklch: true, colorMix: true, mediaRange: true, has: true, focusVisible: true };

class FakeElement {
  tagName: string;
  style: Record<string, string> = {};
  textContent = "";
  parentNode: FakeElement | null = null;
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  classList = { contains: () => false, add: () => {}, remove: () => {}, toggle: () => false };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  appendChild(node: FakeElement): FakeElement {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  removeChild(node: FakeElement): FakeElement {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

function textOf(node: FakeElement): string {
  return [node.textContent, ...node.children.map(textOf)].join(" ");
}

function storageStub(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  return {
    values,
    getItem: (key: string) => (key in values ? values[key] : null),
    setItem: (key: string, value: string) => {
      values[key] = String(value);
    },
  };
}

type ProbeOptions = {
  capabilities: Capabilities;
  userAgent: string;
  desktop?: boolean;
  session?: Record<string, string>;
  local?: Record<string, string>;
  search?: string;
  platform?: string;
};

function runProbe(options: ProbeOptions) {
  const documentElement = new FakeElement("html");
  const head = new FakeElement("head");
  const body = new FakeElement("body");
  const session = storageStub(options.session);
  const local = storageStub(options.local);

  const windowStub: Record<string, unknown> = {
    location: { search: options.search ?? "", reload: () => {} },
    sessionStorage: session,
    localStorage: local,
    matchMedia: (query: string) => ({
      matches: options.capabilities.mediaRange && /[<>]=?/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    getComputedStyle: () => ({
      getPropertyValue: (name: string) => (name === "--dbx-layer-probe" && options.capabilities.layer ? "1" : ""),
    }),
    addEventListener: () => {},
    dispatchEvent: () => {},
  };
  if (options.desktop) windowStub.__TAURI_INTERNALS__ = {};

  const context = vm.createContext({
    window: windowStub,
    document: {
      documentElement,
      head,
      body,
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: () => {},
    },
    navigator: {
      userAgent: options.userAgent,
      platform: options.platform ?? "MacIntel",
      languages: ["zh-CN"],
      language: "zh-CN",
    },
    CSS: {
      supports: (first: string, second?: string) => {
        if (second === undefined) {
          const condition = String(first);
          if (condition.includes("selector(:has")) return options.capabilities.has;
          if (condition.includes("selector(:focus-visible")) return options.capabilities.focusVisible;
          return true;
        }
        const value = String(second);
        if (value.includes("oklch")) return options.capabilities.oklch;
        if (value.includes("color-mix")) return options.capabilities.colorMix;
        return true;
      },
    },
    console: { warn: () => {}, log: () => {} },
    URLSearchParams,
  });

  vm.runInContext(PROBE_SOURCE, context, { filename: "index.html#dbx-compat-probe" });

  const report = windowStub.__DBX_WEBVIEW_COMPAT__ as {
    tier: string;
    missing: string[];
    engine: string;
    bypassed: boolean;
  };
  const notices = body.children.filter((child) => "data-dbx-compat-gate" in child.attributes || "data-dbx-compat-banner" in child.attributes);
  return {
    tier: report.tier,
    missing: report.missing,
    engine: report.engine,
    bypassed: report.bypassed,
    recorded: documentElement.attributes["data-dbx-compat"] ?? null,
    notice: notices.length === 0 ? "none" : "data-dbx-compat-gate" in notices[0].attributes ? "gate" : "banner",
    noticeText: notices.length === 0 ? "" : textOf(notices[0]),
    session: session.values,
    local: local.values,
  };
}

describe("engine compatibility notice rendering", () => {
  it("gates an engine whose whole layered stylesheet would be dropped", () => {
    const result = runProbe({ capabilities: SAFARI_15_2, userAgent: SAFARI_15_2_UA, desktop: true });
    expect(result.tier).toBe("fatal");
    expect(result.notice).toBe("gate");
    expect(result.recorded).toBe("fatal");
    expect(result.missing).toEqual(["layer", "oklch", "color-mix", "media-query-range", "has-selector", "focus-visible"]);
    expect(result.noticeText).toContain("12.7.6");
    expect(result.noticeText).toContain("Safari 17.6");
  });

  it("only banners an engine that still renders the shell", () => {
    const result = runProbe({ capabilities: SAFARI_16_2, userAgent: SAFARI_16_2_UA });
    expect(result.tier).toBe("degraded");
    expect(result.notice).toBe("banner");
    expect(result.missing).toEqual(["media-query-range"]);
  });

  it("banners instead of gating a fixed Chromium-109 webview that lacks the color functions", () => {
    // @layer works, so the stylesheet is not dropped wholesale — only color
    // declarations are. Blocking every launch of such a build would be
    // un-actionable: the runtime is fixed and can never be updated.
    const result = runProbe({ capabilities: CHROMIUM_109, userAgent: WINDOWS_UA, desktop: true });
    expect(result.tier).toBe("degraded");
    expect(result.notice).toBe("banner");
    expect(result.missing).toEqual(["oklch", "color-mix"]);
  });

  it("names exactly what to upgrade instead of a bare 'update it'", () => {
    const mac = runProbe({ capabilities: SAFARI_16_2, userAgent: SAFARI_16_2_UA, desktop: true });
    expect(mac.noticeText).toContain("把 Safari 升级到最新版");

    const web = runProbe({ capabilities: SAFARI_16_2, userAgent: SAFARI_16_2_UA });
    expect(web.noticeText).toContain("把浏览器升级到最新版本");

    // Windows/Linux desktop clients ship their own WebView, so the fix is the operating system.
    const windowsDesktop = runProbe({
      capabilities: SAFARI_16_2,
      userAgent: WINDOWS_UA,
      platform: "Win32",
      desktop: true,
    });
    expect(windowsDesktop.noticeText).toContain("升级操作系统以更新系统内置的 WebView");
    expect(windowsDesktop.noticeText).not.toContain("Safari");
  });

  it("re-asks the gate every session but remembers a dismissed banner", () => {
    expect(runProbe({ capabilities: SAFARI_15_2, userAgent: SAFARI_15_2_UA, desktop: true }).notice).toBe("gate");
    expect(runProbe({ capabilities: SAFARI_15_2, userAgent: SAFARI_15_2_UA, desktop: true, session: {} }).notice).toBe("gate");

    const bypassed = runProbe({ capabilities: SAFARI_15_2, userAgent: SAFARI_15_2_UA, desktop: true, session: { "dbx-compat-bypass": "1" } });
    expect(bypassed.notice).toBe("none");
    expect(bypassed.tier).toBe("fatal");
    expect(bypassed.bypassed).toBe(true);

    const dismissed = runProbe({ capabilities: SAFARI_16_2, userAgent: SAFARI_16_2_UA, local: { "dbx-compat-banner-dismissed": "1" } });
    expect(dismissed.notice).toBe("none");
    expect(dismissed.tier).toBe("degraded");
  });

  it("never lets a dismissed banner silence the blocking gate", () => {
    const result = runProbe({
      capabilities: SAFARI_15_2,
      userAgent: SAFARI_15_2_UA,
      desktop: true,
      local: { "dbx-compat-banner-dismissed": "1" },
    });
    expect(result.tier).toBe("fatal");
    expect(result.notice).toBe("gate");
  });

  it("stays out of the way on an engine that renders the shell", () => {
    const result = runProbe({ capabilities: CHROME_120, userAgent: CHROME_UA, desktop: true });
    expect(result.tier).toBe("ok");
    expect(result.notice).toBe("none");
    expect(result.recorded).toBe("ok");
  });

  it("fails open when the probe itself throws", () => {
    const result = runProbe({ capabilities: CHROME_120, userAgent: CHROME_UA, search: "?dbx-compat=reset" });
    expect(result.tier).toBe("ok");
    expect(result.notice).toBe("none");
  });
});
