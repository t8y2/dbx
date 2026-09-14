import { afterEach, describe, expect, it, vi } from "vitest";

import { clipboardLineEndings, copyToClipboard, type ClipboardEnvironment } from "@/lib/common/clipboard";

afterEach(() => {
  vi.restoreAllMocks();
});

function legacyClipboardEnvironment(activeDialog?: { appendChild: ReturnType<typeof vi.fn>; removeChild: ReturnType<typeof vi.fn> }) {
  const textarea = {
    value: "",
    style: {},
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
  };
  const body = { appendChild: vi.fn(), removeChild: vi.fn() };
  const env: ClipboardEnvironment = {
    navigator: { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } },
    document: {
      body,
      activeElement: activeDialog ? { closest: vi.fn().mockReturnValue(activeDialog) } : undefined,
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(true),
    },
  };
  return { body, env, textarea };
}

describe("copyToClipboard", () => {
  it("keeps the legacy copy target inside the active dialog", async () => {
    const dialog = { appendChild: vi.fn(), removeChild: vi.fn() };
    const { body, env, textarea } = legacyClipboardEnvironment(dialog);

    await copyToClipboard("connection failed", env);

    expect(dialog.appendChild).toHaveBeenCalledWith(textarea);
    expect(dialog.removeChild).toHaveBeenCalledWith(textarea);
    expect(body.appendChild).not.toHaveBeenCalled();
    expect(textarea.value).toBe("connection failed");
  });

  it("uses the document body when no dialog is active", async () => {
    const { body, env, textarea } = legacyClipboardEnvironment();

    await copyToClipboard("copied text", env);

    expect(body.appendChild).toHaveBeenCalledWith(textarea);
    expect(body.removeChild).toHaveBeenCalledWith(textarea);
  });

  it("writes CRLF line endings on Windows", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    const writeText = vi.fn();

    await copyToClipboard("SELECT 1\nFROM t\nWHERE x = 1", { navigator: { clipboard: { writeText } } });

    expect(writeText).toHaveBeenCalledWith("SELECT 1\r\nFROM t\r\nWHERE x = 1");
  });

  it("keeps LF line endings off Windows", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    const writeText = vi.fn();

    await copyToClipboard("SELECT 1\nFROM t", { navigator: { clipboard: { writeText } } });

    expect(writeText).toHaveBeenCalledWith("SELECT 1\nFROM t");
  });
});

describe("clipboardLineEndings", () => {
  it("converts bare LF and CR to CRLF on Windows", () => {
    expect(clipboardLineEndings("a\nb\rc", "windows")).toBe("a\r\nb\r\nc");
  });

  it("leaves text that already uses CRLF untouched", () => {
    expect(clipboardLineEndings("a\r\nb\r\n", "windows")).toBe("a\r\nb\r\n");
  });

  it("leaves single-line text untouched on Windows", () => {
    expect(clipboardLineEndings("SELECT 1", "windows")).toBe("SELECT 1");
  });

  it("returns the text unchanged on other platforms", () => {
    expect(clipboardLineEndings("a\nb", "macos")).toBe("a\nb");
    expect(clipboardLineEndings("a\nb", "linux")).toBe("a\nb");
  });
});
