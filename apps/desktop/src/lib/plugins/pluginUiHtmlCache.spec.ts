// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readPluginUiEntry: vi.fn(),
  readPluginUiAsset: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  readPluginUiEntry: mocks.readPluginUiEntry,
  readPluginUiAsset: mocks.readPluginUiAsset,
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: mocks.isTauriRuntime }));

import { COMPONENT_PLUGINS_UPDATED_EVENT } from "@/lib/updates/componentUpdateEvents";
import { clearPluginUiHtmlCache, getCachedPluginUiHtml, getOrLoadPluginUiHtml, setCachedPluginUiHtml } from "./pluginUiHtmlCache";

function uiEntryPayload(html: string): { dataBase64: string } {
  return { dataBase64: btoa(html) };
}

describe("pluginUiHtmlCache", () => {
  beforeEach(() => {
    clearPluginUiHtmlCache();
    vi.resetAllMocks();
    mocks.isTauriRuntime.mockReturnValue(false);
    const settings = (window as unknown as { happyDOM: { settings: Record<string, boolean> } }).happyDOM.settings;
    settings.disableJavaScriptFileLoading = true;
    settings.disableCSSFileLoading = true;
    settings.handleDisabledFileLoadingAsSuccess = true;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns the stored document for the same plugin id+version key", () => {
    setCachedPluginUiHtml("io.dbx.ssh@0.4.88", { html: "<html>a</html>", entryDirectory: "" });
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.88")).toEqual({ html: "<html>a</html>", entryDirectory: "" });
  });

  it("evicts oldest entries beyond the limit and refreshes on read", () => {
    setCachedPluginUiHtml("k1", { html: "1", entryDirectory: "" });
    setCachedPluginUiHtml("k2", { html: "2", entryDirectory: "" });
    setCachedPluginUiHtml("k3", { html: "3", entryDirectory: "" });
    setCachedPluginUiHtml("k4", { html: "4", entryDirectory: "" });
    // Reading k1 makes it the newest entry.
    expect(getCachedPluginUiHtml("k1")?.html).toBe("1");
    setCachedPluginUiHtml("k5", { html: "5", entryDirectory: "" });
    setCachedPluginUiHtml("k6", { html: "6", entryDirectory: "" });
    // k2/k3 (oldest, untouched) are evicted; k1 survived via the refresh.
    expect(getCachedPluginUiHtml("k1")?.html).toBe("1");
    expect(getCachedPluginUiHtml("k2")).toBeUndefined();
    expect(getCachedPluginUiHtml("k3")).toBeUndefined();
    expect(getCachedPluginUiHtml("k4")?.html).toBe("4");
    expect(getCachedPluginUiHtml("k5")?.html).toBe("5");
    expect(getCachedPluginUiHtml("k6")?.html).toBe("6");
  });

  it("treats a version change as a cache miss", () => {
    setCachedPluginUiHtml("io.dbx.ssh@0.4.88", { html: "old", entryDirectory: "" });
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.89")).toBeUndefined();
  });

  it.each([
    { protocol: "tauri:", prefix: "dbx-plugin://localhost/sample/" },
    { protocol: "http:", prefix: "http://dbx-plugin.localhost/sample/" },
    { protocol: "https:", prefix: "https://dbx-plugin.localhost/sample/" },
  ])("preserves packaged module URL identity and nested import bases for $protocol", async ({ protocol, prefix }) => {
    mocks.isTauriRuntime.mockReturnValue(true);
    vi.stubEnv("PROD", true);
    vi.stubGlobal("location", { protocol });
    mocks.readPluginUiEntry.mockResolvedValueOnce(
      uiEntryPayload(`<!doctype html><html><head>
        <link rel="stylesheet" href="./styles/theme.css" data-theme="dark" disabled>
      </head><body>
        <script src="./legacy.js" defer data-legacy="true"></script>
        <script type="module" src="./entry/app.mjs?rev=1#app" data-test="foo" crossorigin="anonymous"></script>
      </body></html>`),
    );
    mocks.readPluginUiAsset.mockImplementation(async (_pluginId: string, path: string) => ({
      dataBase64: btoa(path.endsWith(".css") ? "body{color:red}" : "window.legacyLoaded = true;"),
    }));

    const result = await getOrLoadPluginUiHtml("sample@1.0.0", "sample");
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"]');
    expect(result.entryDirectory).toBe("styles");
    expect(entry?.getAttribute("src")).toBe(`${prefix}entry/app.mjs?rev=1#app`);
    expect(entry?.getAttribute("data-test")).toBe("foo");
    expect(entry?.getAttribute("crossorigin")).toBe("anonymous");
    expect(entry?.textContent).toBe("");

    // Model the browser's URL resolution through entry → child → deeper. The
    // external module URL, not the document's CSS-oriented <base>, owns each
    // relative import's resolution base.
    if (!entry) throw new Error("Packaged module entry is missing");
    const entryUrl = entry.src;
    const childUrl = new URL("./child/app.mjs", entryUrl).href;
    const deeperUrl = new URL("./deeper/module.mjs", childUrl).href;
    expect(childUrl).toBe(`${prefix}entry/child/app.mjs`);
    expect(deeperUrl).toBe(`${prefix}entry/child/deeper/module.mjs`);

    const legacy = document.querySelector<HTMLScriptElement>('script[data-legacy="true"]');
    expect(legacy?.hasAttribute("src")).toBe(false);
    expect(legacy?.hasAttribute("defer")).toBe(true);
    expect(legacy?.textContent).toBe("window.legacyLoaded = true;");
    const stylesheet = document.querySelector<HTMLStyleElement>("style[data-theme=dark]");
    expect(stylesheet?.hasAttribute("disabled")).toBe(true);
    expect(stylesheet?.textContent).toBe("body{color:red}");
    expect(mocks.readPluginUiAsset.mock.calls.map(([, path]) => path)).toEqual(["styles/theme.css", "legacy.js"]);
  });

  it("keeps the inline fallback for module scripts in dev despite the tauri runtime", async () => {
    // `tauri dev` serves the app from the devUrl (http(s):), where the module
    // URL rewrite would land on the WebView2-only subdomain form that
    // WKWebView/webkit2gtk never serve — the entry must stay inline in dev.
    mocks.isTauriRuntime.mockReturnValue(true);
    vi.stubEnv("PROD", false);
    vi.stubGlobal("location", { protocol: "http:" });
    mocks.readPluginUiEntry.mockResolvedValueOnce(uiEntryPayload('<html><body><script type="module" src="./entry/app.mjs" data-dev="1"></script></body></html>'));
    mocks.readPluginUiAsset.mockResolvedValueOnce({ dataBase64: btoa('await import("./child/app.mjs");') });

    const result = await getOrLoadPluginUiHtml("sample@dev", "sample");
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const module = document.querySelector<HTMLScriptElement>('script[type="module"]');
    expect(module?.hasAttribute("src")).toBe(false);
    expect(module?.getAttribute("data-dev")).toBe("1");
    expect(module?.textContent).toBe('await import("./child/app.mjs");');
    expect(mocks.readPluginUiAsset).toHaveBeenCalledWith("sample", "entry/app.mjs");
  });

  it("keeps inline fallback for hosts without the plugin asset protocol", async () => {
    mocks.readPluginUiEntry.mockResolvedValueOnce(uiEntryPayload('<html><body><script type="module" src="./entry/app.mjs" data-test="web"></script></body></html>'));
    mocks.readPluginUiAsset.mockResolvedValueOnce({ dataBase64: btoa('await import("./child/app.mjs");') });

    const result = await getOrLoadPluginUiHtml("sample@web", "sample");
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const module = document.querySelector<HTMLScriptElement>('script[type="module"]');
    expect(module?.hasAttribute("src")).toBe(false);
    expect(module?.getAttribute("data-test")).toBe("web");
    expect(module?.textContent).toBe('await import("./child/app.mjs");');
    expect(mocks.readPluginUiAsset).toHaveBeenCalledWith("sample", "entry/app.mjs");
  });

  it("invalidates on dbx:plugins-changed so a same-version reinstall re-reads the build", async () => {
    setCachedPluginUiHtml("io.dbx.ssh@0.4.88", { html: "stale", entryDirectory: "" });
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.88")).toBeUndefined();
    // The next workbench boot pays a fresh bridge read instead of serving stale bytes.
    mocks.readPluginUiEntry.mockResolvedValueOnce(uiEntryPayload("<html>fresh</html>"));
    await expect(getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh")).resolves.toEqual({ html: "<html>fresh</html>", entryDirectory: "" });
  });

  it("invalidates on the component plugins updated event", () => {
    setCachedPluginUiHtml("io.dbx.ssh@0.4.88", { html: "stale", entryDirectory: "" });
    window.dispatchEvent(new Event(COMPONENT_PLUGINS_UPDATED_EVENT));
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.88")).toBeUndefined();
  });

  it("does not repopulate the cache when an invalidated load completes", async () => {
    let resolveStale!: (value: { dataBase64: string }) => void;
    mocks.readPluginUiEntry.mockReturnValueOnce(new Promise((resolve) => (resolveStale = resolve)));
    const staleLoad = getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh");

    window.dispatchEvent(new Event("dbx:plugins-changed"));
    mocks.readPluginUiEntry.mockResolvedValueOnce(uiEntryPayload("<html>fresh</html>"));
    const freshLoad = getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh");
    resolveStale(uiEntryPayload("<html>stale</html>"));

    await expect(staleLoad).resolves.toEqual({ html: "<html>stale</html>", entryDirectory: "" });
    await expect(freshLoad).resolves.toEqual({ html: "<html>fresh</html>", entryDirectory: "" });
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.88")).toEqual({ html: "<html>fresh</html>", entryDirectory: "" });
  });

  it("getOrLoad resolves from the cache without touching the bridge", async () => {
    setCachedPluginUiHtml("io.dbx.ssh@0.4.88", { html: "cached", entryDirectory: "" });
    await expect(getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh")).resolves.toEqual({ html: "cached", entryDirectory: "" });
    expect(mocks.readPluginUiEntry).not.toHaveBeenCalled();
  });

  it("coalesces concurrent misses into one pipeline run and caches the document", async () => {
    let release!: (value: { dataBase64: string }) => void;
    mocks.readPluginUiEntry.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const first = getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh");
    const second = getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh");
    release(uiEntryPayload("<html>doc</html>"));
    await expect(first).resolves.toEqual({ html: "<html>doc</html>", entryDirectory: "" });
    await expect(second).resolves.toEqual({ html: "<html>doc</html>", entryDirectory: "" });
    // One bridge read served both callers (dock warm + panel mount).
    expect(mocks.readPluginUiEntry).toHaveBeenCalledTimes(1);
    // Subsequent callers hit the LRU without a new read.
    await expect(getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh")).resolves.toEqual({ html: "<html>doc</html>", entryDirectory: "" });
    expect(mocks.readPluginUiEntry).toHaveBeenCalledTimes(1);
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.88")).toEqual({ html: "<html>doc</html>", entryDirectory: "" });
  });

  it("keeps the cache untouched on failure and lets the next caller retry", async () => {
    mocks.readPluginUiEntry.mockRejectedValueOnce(new Error("bridge down"));
    await expect(getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh")).rejects.toThrow("bridge down");
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.88")).toBeUndefined();
    // The failed in-flight slot is cleared, so a retry re-runs the pipeline.
    mocks.readPluginUiEntry.mockResolvedValueOnce(uiEntryPayload("<html>retry</html>"));
    await expect(getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh")).resolves.toEqual({ html: "<html>retry</html>", entryDirectory: "" });
    expect(mocks.readPluginUiEntry).toHaveBeenCalledTimes(2);
  });
});
