// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, reactive, type EffectScope } from "vue";
import { BACKGROUND_IMAGE_SURFACE_VARS, defaultBackgroundImageSettings, type BackgroundImageSettings } from "@/lib/app/appBackgroundImage";
import type { BackgroundImageComposable } from "@/composables/useBackgroundImage";

const readBackgroundImageMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend/api", () => ({ readBackgroundImage: readBackgroundImageMock }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/app/appAppearance", () => ({ persistAppAppearancePatch: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe("background image theme and scope lifecycle", () => {
  let useBackgroundImage: typeof import("@/composables/useBackgroundImage").useBackgroundImage;
  let theme: ReturnType<typeof import("@/composables/useTheme").useTheme>;
  let scope: EffectScope;
  let style: HTMLStyleElement;
  let systemThemeChanged: (event: { matches: boolean }) => void;
  const createObjectURL = vi.fn();
  const revokeObjectURL = vi.fn();

  function mount(overrides: Partial<BackgroundImageSettings> = {}) {
    const settings = { editorSettings: reactive({ backgroundImage: { ...defaultBackgroundImageSettings(), ...overrides } }) } as Parameters<typeof useBackgroundImage>[0];
    scope = effectScope();
    const bg = scope.run(() => useBackgroundImage(settings))!;
    return { bg, settings };
  }

  function token(name: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function expectInactive(bg: BackgroundImageComposable) {
    expect(bg.active.value).toBe(false);
    expect(bg.backgroundObjectUrl.value).toBeNull();
    expect(bg.backgroundImageStyle.value).toEqual({});
    expect(document.documentElement.classList.contains("dbx-bg-active")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--background-solid")).toBe("");
  }

  beforeEach(async () => {
    vi.resetModules();
    readBackgroundImageMock.mockReset().mockResolvedValue("aGVsbG8=");
    createObjectURL.mockReset().mockImplementation(() => `blob:bg-${createObjectURL.mock.calls.length}`);
    revokeObjectURL.mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectURL);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL);
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      addEventListener: (_event: string, listener: typeof systemThemeChanged) => {
        systemThemeChanged = listener;
      },
    } as MediaQueryList);
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    style = document.createElement("style");
    style.textContent = `
      :root { --background: rgb(255 255 255); --sidebar: rgb(248 248 248); --dbx-content: var(--background); }
      :root.dark { --background: rgb(10 10 10); --sidebar: rgb(24 24 24); }
      :root.theme-cobalt { --background: rgb(240 246 255); }
    `;
    document.head.append(style);
    theme = (await import("@/composables/useTheme")).useTheme();
    theme.setThemeMode("light");
    theme.setThemePalette("pearl");
    ({ useBackgroundImage } = await import("@/composables/useBackgroundImage"));
  });

  afterEach(async () => {
    scope?.stop();
    await settle();
    style.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("leaves default surfaces opaque without reading an unconfigured file", async () => {
    const { bg } = mount();
    await settle();
    expectInactive(bg);
    expect(token("--background")).toBe("rgb(255 255 255)");
    expect(readBackgroundImageMock).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ["light", 0.05, "255 255 255"],
    ["light", 0.8, "255 255 255"],
    ["dark", 0.05, "10 10 10"],
    ["dark", 0.8, "10 10 10"],
  ] as const)("keeps built-in %s text opaque at surface opacity %s", async (mode, opacity, rgb) => {
    theme.setThemeMode(mode);
    const { bg } = mount({ filePath: "/wall.png", opacity });
    await settle();
    expect(bg.active.value).toBe(true);
    expect(token("--background")).toBe(`rgb(${rgb} / ${opacity})`);
    expect(token("--background-solid")).toBe(`rgb(${rgb})`);
    expect(token("--dbx-content")).toBe(`rgb(${rgb} / ${opacity})`);
    expect(token("--sidebar-solid")).toBe("");
  });

  it.each(["same mode", "equivalent system", "same palette", "same corners", "apply theme"])("restores wallpaper opacity after %s", async (action) => {
    const { bg } = mount({ filePath: "/wall.png", opacity: 0.05 });
    await settle();
    const revision = theme.themeRevision.value;
    if (action === "same mode") theme.setThemeMode("light");
    if (action === "equivalent system") theme.setThemeMode("system");
    if (action === "same palette") theme.setThemePalette("pearl");
    if (action === "same corners") theme.setCornerStyle(theme.cornerStyle.value);
    if (action === "apply theme") theme.applyTheme();
    await settle();
    expect(token("--background")).toBe("rgb(255 255 255 / 0.05)");
    expect(token("--background-solid")).toBe("rgb(255 255 255)");
    expect(theme.themeRevision.value).toBe(revision + 1);
    expect(bg.backgroundObjectUrl.value).toBe("blob:bg-1");
    expect(readBackgroundImageMock).toHaveBeenCalledTimes(1);
  });

  it("follows dark/light and system appearance changes without reloading the image", async () => {
    const { bg } = mount({ filePath: "/wall.png", opacity: 0.05 });
    await settle();
    for (const mode of ["dark", "light", "system"] as const) {
      theme.setThemeMode(mode);
      await settle();
      const rgb = mode === "dark" ? "10 10 10" : "255 255 255";
      expect(token("--background")).toBe(`rgb(${rgb} / 0.05)`);
      expect(token("--background-solid")).toBe(`rgb(${rgb})`);
    }
    systemThemeChanged({ matches: true });
    await settle();
    expect(token("--background")).toBe("rgb(10 10 10 / 0.05)");
    expect(token("--background-solid")).toBe("rgb(10 10 10)");
    expect(bg.backgroundObjectUrl.value).toBe("blob:bg-1");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("restores previews on cancellation and reapplies a committed preview", async () => {
    mount({ filePath: "/wall.png", opacity: 0.05 });
    await settle();
    theme.previewThemePalette("cobalt");
    await settle();
    expect(token("--background")).toBe("rgb(240 246 255 / 0.05)");
    expect(token("--background-solid")).toBe("rgb(240 246 255)");
    theme.clearThemePalettePreview();
    await settle();
    expect(token("--background")).toBe("rgb(255 255 255 / 0.05)");
    theme.previewThemePalette("cobalt");
    await settle();
    theme.setThemePalette("cobalt");
    await settle();
    expect(token("--background")).toBe("rgb(240 246 255 / 0.05)");
    expect(token("--background-solid")).toBe("rgb(240 246 255)");
  });

  it("preserves custom colors through edits, preview cancellation and removal", async () => {
    theme.setCustomUiColors({ ...theme.activeCustomUiColors.value, background: "#123456", sidebar: "#654321" });
    theme.setThemePalette("custom");
    const { bg, settings } = mount({ filePath: "/wall.png", opacity: 0.8 });
    await settle();
    expect(token("--background")).toBe("rgb(18 52 86 / 0.8)");
    expect(token("--background-solid")).toBe("rgb(18 52 86)");
    expect(token("--sidebar")).toBe("rgb(101 67 33 / 0.8)");
    theme.previewThemePalette("pearl");
    await settle();
    theme.clearThemePalettePreview();
    await settle();
    expect(token("--background")).toBe("rgb(18 52 86 / 0.8)");
    theme.setThemeMode("dark");
    theme.setCustomUiColors({ ...theme.activeCustomUiColors.value, background: "#abcdef" });
    await settle();
    expect(token("--background")).toBe("rgb(171 205 239 / 0.8)");
    expect(token("--background-solid")).toBe("rgb(171 205 239)");
    theme.setThemeMode("light");
    await settle();
    settings.editorSettings.backgroundImage = defaultBackgroundImageSettings();
    await settle();
    expectInactive(bg);
    expect(token("--background")).toBe("rgb(18 52 86)");
    expect(token("--sidebar")).toBe("rgb(101 67 33)");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:bg-1");
  });

  it("restores wallpaper after a palette preview is cancelled in the same tick", async () => {
    mount({ filePath: "/wall.png", opacity: 0.05 });
    await settle();
    theme.previewThemePalette("cobalt");
    theme.clearThemePalettePreview();
    await settle();
    expect(token("--background")).toBe("rgb(255 255 255 / 0.05)");
    expect(token("--background-solid")).toBe("rgb(255 255 255)");
  });

  it("restores defaults when all appearance and wallpaper settings reset together", async () => {
    theme.setThemePalette("custom");
    const { bg, settings } = mount({ filePath: "/wall.png", opacity: 0.05 });
    await settle();
    settings.editorSettings.backgroundImage = defaultBackgroundImageSettings();
    theme.resetCustomUiColors();
    theme.setThemePalette("pearl");
    theme.setThemeMode("system");
    theme.setCornerStyle("large");
    await settle();
    expectInactive(bg);
    for (const name of BACKGROUND_IMAGE_SURFACE_VARS) expect(document.documentElement.style.getPropertyValue(name)).toBe("");
    expect(token("--background")).toBe("rgb(255 255 255)");
  });

  it("updates opacity and layout without reloading or tinting text", async () => {
    const { bg, settings } = mount({ filePath: "/wall.png" });
    await settle();
    expect(token("--background")).toBe("rgb(255 255 255 / 0.8)");
    settings.editorSettings.backgroundImage.opacity = 1;
    settings.editorSettings.backgroundImage.displayMode = "tile";
    settings.editorSettings.backgroundImage.blur = 4;
    await settle();
    expect(token("--background")).toBe("rgb(255 255 255 / 1)");
    expect(token("--background-solid")).toBe("rgb(255 255 255)");
    expect(bg.backgroundImageStyle.value).toMatchObject({ backgroundRepeat: "repeat", filter: "blur(4px)" });
    expect(readBackgroundImageMock).toHaveBeenCalledTimes(1);
  });

  it.each(["pearl", "custom"] as const)("keeps %s surfaces opaque when reading fails", async (palette) => {
    theme.setThemePalette(palette);
    const original = token("--background");
    readBackgroundImageMock.mockRejectedValue(new Error("gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bg } = mount({ filePath: "/missing.png" });
    await settle();
    expectInactive(bg);
    expect(token("--background")).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("revokes a replaced URL and falls back after a later read failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bg, settings } = mount({ filePath: "/first.png" });
    await settle();
    settings.editorSettings.backgroundImage.filePath = "/second.png";
    await settle();
    expect(bg.backgroundObjectUrl.value).toBe("blob:bg-2");
    expect(revokeObjectURL.mock.calls).toEqual([["blob:bg-1"]]);
    readBackgroundImageMock.mockRejectedValue(new Error("gone"));
    settings.editorSettings.backgroundImage.filePath = "/missing.png";
    await settle();
    expectInactive(bg);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:bg-1"], ["blob:bg-2"]]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("ignores an older read after a newer image loads", async () => {
    const first = deferred<string>();
    readBackgroundImageMock.mockReturnValueOnce(first.promise);
    const { bg, settings } = mount({ filePath: "/first.png" });
    settings.editorSettings.backgroundImage.filePath = "/second.png";
    await settle();
    expect(bg.backgroundObjectUrl.value).toBe("blob:bg-1");
    first.resolve("b2xk");
    await settle();
    expect(bg.backgroundObjectUrl.value).toBe("blob:bg-1");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("keeps the newer image when an older read rejects", async () => {
    const first = deferred<string>();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readBackgroundImageMock.mockReturnValueOnce(first.promise);
    const { bg, settings } = mount({ filePath: "/first.png" });
    settings.editorSettings.backgroundImage.filePath = "/second.png";
    await settle();
    first.reject(new Error("stale"));
    await settle();
    expect(bg.backgroundObjectUrl.value).toBe("blob:bg-1");
    expect(bg.active.value).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("cancels a same-tick path round trip and uses the final theme when loading finishes", async () => {
    const first = deferred<string>();
    const last = deferred<string>();
    readBackgroundImageMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const { bg, settings } = mount({ filePath: "/wall.png" });
    settings.editorSettings.backgroundImage.filePath = null;
    settings.editorSettings.backgroundImage.filePath = "/wall.png";
    theme.setThemeMode("dark");
    theme.setThemeMode("dark");
    first.resolve("b2xk");
    await settle();
    expectInactive(bg);
    last.resolve("aGVsbG8=");
    await settle();
    expect(bg.backgroundObjectUrl.value).toBe("blob:bg-1");
    expect(token("--background")).toBe("rgb(10 10 10 / 0.8)");
    expect(token("--background-solid")).toBe("rgb(10 10 10)");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("does not reload an unchanged path when settings are replaced", async () => {
    const { bg, settings } = mount({ filePath: "/wall.png" });
    await settle();
    settings.editorSettings.backgroundImage = { ...settings.editorSettings.backgroundImage, opacity: 0.05 };
    theme.writeRootToken("--font-sans", "monospace");
    const revision = theme.themeRevision.value;
    await settle();
    expect(token("--background")).toBe("rgb(255 255 255 / 0.05)");
    expect(token("--background-solid")).toBe("rgb(255 255 255)");
    expect(theme.themeRevision.value).toBe(revision);
    expect(bg.backgroundObjectUrl.value).toBe("blob:bg-1");
    expect(readBackgroundImageMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to opaque surfaces when image data is malformed", async () => {
    readBackgroundImageMock.mockResolvedValue("not valid base64!");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bg } = mount({ filePath: "/broken.png" });
    await settle();
    expectInactive(bg);
    expect(token("--background")).toBe("rgb(255 255 255)");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"] as const)("ignores a read that settles with %s after removal", async (result) => {
    const pending = deferred<string>();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readBackgroundImageMock.mockReturnValueOnce(pending.promise);
    const { bg, settings } = mount({ filePath: "/wall.png" });
    settings.editorSettings.backgroundImage.filePath = null;
    await settle();
    if (result === "resolve") pending.resolve("aGVsbG8=");
    else pending.reject(new Error("cancelled"));
    await settle();
    expectInactive(bg);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reloads the previous path after cancelling an intervening read", async () => {
    const pending = deferred<string>();
    const { bg, settings } = mount({ filePath: "/first.png" });
    await settle();
    readBackgroundImageMock.mockReturnValueOnce(pending.promise);
    settings.editorSettings.backgroundImage.filePath = "/second.png";
    await settle();
    settings.editorSettings.backgroundImage.filePath = "/first.png";
    await settle();
    pending.resolve("b2xk");
    await settle();
    expect(readBackgroundImageMock.mock.calls).toEqual([["/first.png"], ["/second.png"], ["/first.png"]]);
    expect(bg.backgroundObjectUrl.value).toBe("blob:bg-2");
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a URL after removal and rapid mode changes in one tick", async () => {
    const pending = deferred<string>();
    readBackgroundImageMock.mockReturnValueOnce(pending.promise);
    const { bg, settings } = mount({ filePath: "/wall.png" });
    settings.editorSettings.backgroundImage.filePath = null;
    pending.resolve("aGVsbG8=");
    theme.setThemeMode("dark");
    theme.setThemeMode("light");
    await settle();
    expectInactive(bg);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each(["pearl", "custom"] as const)("revokes the URL and restores %s surfaces on disposal", async (palette) => {
    theme.setThemePalette(palette);
    const original = token("--background");
    const { bg, settings } = mount({ filePath: "/wall.png" });
    await settle();
    scope.stop();
    await settle();
    expectInactive(bg);
    expect(token("--background")).toBe(original);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:bg-1"]]);
    settings.editorSettings.backgroundImage.filePath = "/ignored.png";
    await settle();
    expect(readBackgroundImageMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending load after its scope is disposed", async () => {
    const pending = deferred<string>();
    readBackgroundImageMock.mockReturnValueOnce(pending.promise);
    const { bg } = mount({ filePath: "/wall.png" });
    await settle();
    scope.stop();
    pending.resolve("aGVsbG8=");
    await settle();
    expectInactive(bg);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("keeps a remounted wallpaper independent of the disposed loader", async () => {
    const pending = deferred<string>();
    readBackgroundImageMock.mockReturnValueOnce(pending.promise);
    const previous = mount({ filePath: "/old.png" });
    await settle();
    scope.stop();
    const current = mount({ filePath: "/new.png" });
    await settle();
    pending.resolve("b2xk");
    await settle();
    expect(previous.bg.backgroundObjectUrl.value).toBeNull();
    expect(current.bg.backgroundObjectUrl.value).toBe("blob:bg-1");
    expect(token("--background")).toBe("rgb(255 255 255 / 0.8)");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("clears body, #root, outer app shell, welcome screen and CodeMirror scroller in globals.css", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const globalsCss = fs.readFileSync(path.resolve(__dirname, "../../styles/globals.css"), "utf8");
    expect(globalsCss).toContain("html.dbx-bg-active,");
    expect(globalsCss).toContain("html.dbx-bg-active body,");
    expect(globalsCss).toContain("html.dbx-bg-active #root,");
    expect(globalsCss).toContain("html.dbx-bg-active [data-app-shell],");
    expect(globalsCss).toContain("html.dbx-bg-active [data-welcome-screen],");
    expect(globalsCss).toContain("html.dbx-bg-active .cm-editor,");
    expect(globalsCss).toContain("html.dbx-bg-active .cm-gutters,");
    expect(globalsCss).toContain("html.dbx-bg-active .cm-scroller");
  });
});
