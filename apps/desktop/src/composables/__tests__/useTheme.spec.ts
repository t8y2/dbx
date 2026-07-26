// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mediaQueryChangeListener: ((event: MediaQueryListEvent) => void) | undefined;
let mediaQueryMatches = false;
const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
  callback(0);
  return 0;
});
const setTheme = vi.fn(async () => {});

function installLocalStorageStub() {
  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => [...store.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => store.delete(key)),
    setItem: vi.fn((key: string, value: string) => store.set(key, String(value))),
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

function installBrowserStubs() {
  const mediaQuery = {
    get matches() {
      return mediaQueryMatches;
    },
    addEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === "change") mediaQueryChangeListener = listener;
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => mediaQuery) });
}

async function loadTheme(mode: "light" | "dark" | "system" = "system") {
  window.localStorage.setItem("dbx-theme", mode);
  const { useTheme } = await import("@/composables/useTheme");
  return useTheme();
}

async function flushDynamicImport() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useTheme on Linux", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorageStub();
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    mediaQueryChangeListener = undefined;
    mediaQueryMatches = false;
    installBrowserStubs();
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
    vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme }) }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/backend/tauriRuntime");
    vi.doUnmock("@tauri-apps/api/window");
    vi.unstubAllGlobals();
  });

  it("uses the Linux system preference after a fresh startup without overwriting GTK", async () => {
    mediaQueryMatches = true;
    const theme = await loadTheme();

    theme.applyTheme();

    expect(theme.isDark.value).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("continues to apply system preference changes without writing the native theme", async () => {
    const theme = await loadTheme();
    theme.applyTheme();

    mediaQueryChangeListener?.({ matches: true } as MediaQueryListEvent);

    expect(theme.isDark.value).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("still writes explicit dark and light choices to the native Linux window theme", async () => {
    const theme = await loadTheme("dark");
    expect(theme.themeMode.value).toBe("dark");

    theme.applyTheme();
    await flushDynamicImport();
    expect(setTheme).toHaveBeenLastCalledWith("dark");

    theme.setThemeMode("light");
    await flushDynamicImport();
    expect(setTheme).toHaveBeenLastCalledWith("light");
  });
});
