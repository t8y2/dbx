// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

async function loadAppearance() {
  vi.resetModules();
  return import("@/lib/app/appAppearance");
}

beforeEach(() => {
  invoke.mockReset();
  window.localStorage.clear();
});

describe("Tauri appearance persistence", () => {
  it("gives durable backend values precedence over stale WebView storage", async () => {
    window.localStorage.setItem("dbx-locale", "en");
    window.localStorage.setItem("dbx-theme", "light");
    window.localStorage.setItem("dbx-theme-palette", "pearl");
    invoke.mockResolvedValueOnce({ locale: "zh-CN", themeMode: "dark", themePalette: "cobalt", cornerStyle: "small" });

    const { hydrateAppAppearance } = await loadAppearance();
    await hydrateAppAppearance();

    expect(window.localStorage.getItem("dbx-locale")).toBe("zh-CN");
    expect(window.localStorage.getItem("dbx-theme")).toBe("dark");
    expect(window.localStorage.getItem("dbx-theme-palette")).toBe("cobalt");
    expect(window.localStorage.getItem("dbx-corner-style")).toBe("small");
    expect(invoke).toHaveBeenCalledWith("load_app_appearance_settings", undefined);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("migrates legacy WebView values when the durable record is empty", async () => {
    window.localStorage.setItem("dbx-locale", "ja");
    window.localStorage.setItem("dbx-theme", "system");
    window.localStorage.setItem("dbx-theme-palette", "sage");
    invoke.mockResolvedValueOnce({});
    invoke.mockResolvedValueOnce(undefined);

    const { hydrateAppAppearance } = await loadAppearance();
    await hydrateAppAppearance();

    expect(invoke).toHaveBeenNthCalledWith(1, "load_app_appearance_settings", undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, "update_app_appearance_settings", {
      patch: { locale: "ja", themeMode: "system", themePalette: "sage" },
    });
    expect(window.localStorage.getItem("dbx-theme-palette")).toBe("sage");
  });

  it("persists explicit choices while leaving the caller synchronous", async () => {
    invoke.mockResolvedValue(undefined);
    const { persistAppAppearancePatch, persistAppLocale } = await loadAppearance();

    persistAppAppearancePatch({ themeMode: "dark", themePalette: "graphite" });
    persistAppLocale("ko");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.localStorage.getItem("dbx-theme")).toBe("dark");
    expect(window.localStorage.getItem("dbx-theme-palette")).toBe("graphite");
    expect(window.localStorage.getItem("dbx-locale")).toBe("ko");
    expect(invoke).toHaveBeenNthCalledWith(1, "update_app_appearance_settings", {
      patch: { themeMode: "dark", themePalette: "graphite" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "set_app_locale", { locale: "ko" });
  });
});
