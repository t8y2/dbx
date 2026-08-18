import { describe, expect, it, vi } from "vitest";

import { copyToClipboard, type ClipboardEnvironment } from "@/lib/common/clipboard";

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
});
