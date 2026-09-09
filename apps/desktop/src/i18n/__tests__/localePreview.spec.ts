// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentLocale, previewLocale, restoreLocalePreview, setLocale } from "@/i18n";

const delayedItalianLocale = vi.hoisted(() => {
  let resolveLocaleModule: ((module: { default: Record<string, unknown> }) => void) | undefined;
  let pendingLocaleModule: Promise<{ default: Record<string, unknown> }>;

  function reset() {
    pendingLocaleModule = new Promise((resolve) => {
      resolveLocaleModule = resolve;
    });
  }

  reset();

  return {
    reset,
    load: () => pendingLocaleModule,
    resolve: () => resolveLocaleModule?.({ default: {} }),
  };
});

vi.mock("@/i18n/locales/it", () => delayedItalianLocale.load());

describe("locale preview", () => {
  beforeEach(async () => {
    delayedItalianLocale.reset();
    await setLocale("en");
    window.localStorage.clear();
  });

  afterEach(async () => {
    await setLocale("en");
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("changes the visible locale without persisting a hover preview", async () => {
    const setItem = vi.spyOn(window.localStorage, "setItem");

    await previewLocale("es");

    expect(currentLocale()).toBe("es");
    expect(setItem).not.toHaveBeenCalled();

    await restoreLocalePreview();
    expect(currentLocale()).toBe("en");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps the most recent asynchronous preview", async () => {
    const firstPreview = previewLocale("zh-CN");
    const latestPreview = previewLocale("ja");

    await Promise.all([firstPreview, latestPreview]);

    expect(currentLocale()).toBe("ja");
    await restoreLocalePreview();
    expect(currentLocale()).toBe("en");
  });

  it("restores a selected locale when closing its list before loading finishes", async () => {
    const selected = setLocale("ko");
    const restore = restoreLocalePreview();

    await Promise.all([selected, restore]);

    expect(currentLocale()).toBe("ko");
    expect(window.localStorage.getItem("dbx-locale")).toBe("ko");
  });

  it("persists an explicit choice before its delayed messages become visible", async () => {
    const selected = setLocale("it");

    expect(window.localStorage.getItem("dbx-locale")).toBe("it");
    expect(currentLocale()).toBe("en");

    delayedItalianLocale.resolve();
    await selected;

    expect(currentLocale()).toBe("it");
  });
});
