import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const indexHtml = readFileSync(fileURLToPath(new URL("../../../../index.html", import.meta.url)), "utf8");
const startupScript = indexHtml.match(/<script data-dbx-startup-theme>([\s\S]*?)<\/script>/)?.[1];

if (!startupScript) throw new Error("Startup theme script not found");

type StartupThemeOptions = {
  mode?: string | null;
  cornerStyle?: string | null;
  prefersDark?: boolean;
  storageError?: boolean;
};

function runStartupTheme({ mode = null, cornerStyle = null, prefersDark = false, storageError = false }: StartupThemeOptions = {}) {
  const toggle = vi.fn();
  const root = { classList: { toggle }, dataset: { cornerStyle: "" }, style: { colorScheme: "" } };
  const localStorage = {
    getItem: vi.fn((key: string) => {
      if (storageError) throw new DOMException("Storage unavailable", "SecurityError");
      return key === "dbx-corner-style" ? cornerStyle : mode;
    }),
  };
  const matchMedia = vi.fn(() => ({ matches: prefersDark }));

  Function("document", "localStorage", "window", startupScript)({ documentElement: root }, localStorage, { matchMedia });

  return { matchMedia, root, toggle };
}

describe("startup theme", () => {
  it("applies dark mode before the application mounts", () => {
    const { matchMedia, root, toggle } = runStartupTheme({ mode: "dark" });

    expect(toggle).toHaveBeenCalledWith("dark", true);
    expect(root.style.colorScheme).toBe("dark");
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("keeps explicit light mode light", () => {
    const { matchMedia, root, toggle } = runStartupTheme({ mode: "light", prefersDark: true });

    expect(toggle).toHaveBeenCalledWith("dark", false);
    expect(root.style.colorScheme).toBe("light");
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it.each([
    [true, "dark"],
    [false, "light"],
  ])("resolves system mode when prefersDark is %s", (prefersDark, appearance) => {
    const { matchMedia, root, toggle } = runStartupTheme({ mode: "system", prefersDark });

    expect(toggle).toHaveBeenCalledWith("dark", prefersDark);
    expect(root.style.colorScheme).toBe(appearance);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
  });

  it("uses the current light default when no preference exists", () => {
    const { root, toggle } = runStartupTheme();

    expect(toggle).toHaveBeenCalledWith("dark", false);
    expect(root.style.colorScheme).toBe("light");
  });

  it.each([
    [null, "large"],
    ["invalid", "large"],
    ["none", "none"],
    ["small", "small"],
    ["large", "large"],
  ])("normalizes the startup corner style %s to %s", (cornerStyle, expected) => {
    const { root } = runStartupTheme({ cornerStyle });

    expect(root.dataset.cornerStyle).toBe(expected);
  });

  it("falls back to light when localStorage is unavailable", () => {
    const { root, toggle } = runStartupTheme({ storageError: true, prefersDark: true });

    expect(toggle).toHaveBeenCalledWith("dark", false);
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.cornerStyle).toBe("large");
  });

  it("falls back to light for an invalid persisted mode", () => {
    const { root, toggle } = runStartupTheme({ mode: "invalid", prefersDark: true });

    expect(toggle).toHaveBeenCalledWith("dark", false);
    expect(root.style.colorScheme).toBe("light");
  });

  it("falls back to light when system appearance detection is unavailable", () => {
    const toggle = vi.fn();
    const root = { classList: { toggle }, dataset: { cornerStyle: "" }, style: { colorScheme: "" } };

    Function("document", "localStorage", "window", startupScript)({ documentElement: root }, { getItem: () => "system" }, {});

    expect(toggle).toHaveBeenCalledWith("dark", false);
    expect(root.style.colorScheme).toBe("light");
  });

  it.each([
    ["soft-dark", true],
    ["soft-light", false],
  ])("preserves legacy %s mode", (mode, dark) => {
    const { toggle } = runStartupTheme({ mode });

    expect(toggle).toHaveBeenCalledWith("dark", dark);
  });
});
