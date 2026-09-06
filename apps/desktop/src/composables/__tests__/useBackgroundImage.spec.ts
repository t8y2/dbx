// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { BACKGROUND_IMAGE_ACTIVE_CLASS, useBackgroundImage } from "@/composables/useBackgroundImage";
import { defaultBackgroundImageSettings, type BackgroundImageSettings } from "@/lib/app/appBackgroundImage";

const readBackgroundImageMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backend/api", () => ({
  readBackgroundImage: readBackgroundImageMock,
}));

function settingsWith(overrides: Partial<BackgroundImageSettings>) {
  const base = defaultBackgroundImageSettings();
  return { editorSettings: reactive({ backgroundImage: { ...base, ...overrides } }) } as Parameters<typeof useBackgroundImage>[0];
}

describe("useBackgroundImage", () => {
  beforeEach(() => {
    vi.resetModules();
    readBackgroundImageMock.mockReset();
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    document.documentElement.className = "";
  });

  it("reports no active background without a configured file", () => {
    const bg = useBackgroundImage(settingsWith({}));
    expect(bg.backgroundObjectUrl.value).toBeNull();
    expect(bg.active.value).toBe(false);
    expect(document.documentElement.classList.contains(BACKGROUND_IMAGE_ACTIVE_CLASS)).toBe(false);
  });

  it("loads the configured file into an object URL and toggles the global wallpaper class", async () => {
    const createObjectURL = vi.fn(() => "blob:bg-1");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true, writable: true });
    readBackgroundImageMock.mockResolvedValue("aGVsbG8=");

    const bg = useBackgroundImage(settingsWith({ filePath: "/data/background-image.png", fileName: "wall.png" }));
    await vi.waitFor(() => expect(bg.backgroundObjectUrl.value).toBe("blob:bg-1"));
    expect(bg.active.value).toBe(true);
    expect(document.documentElement.classList.contains(BACKGROUND_IMAGE_ACTIVE_CLASS)).toBe(true);
  });

  it("falls back to no background when the file cannot be read", async () => {
    readBackgroundImageMock.mockRejectedValue(new Error("gone"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const bg = useBackgroundImage(settingsWith({ filePath: "/data/background-image.png" }));
    await vi.waitFor(() => expect(readBackgroundImageMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(bg.backgroundObjectUrl.value).toBeNull();
    expect(bg.active.value).toBe(false);
    expect(document.documentElement.classList.contains(BACKGROUND_IMAGE_ACTIVE_CLASS)).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
