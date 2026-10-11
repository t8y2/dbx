// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { copyDialogPasswordFieldValue, preventDialogDocumentSelectAll } from "../dialogTextSelection";

function keyboardEvent(target: EventTarget, options: { key?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) {
  return {
    key: options.key ?? "a",
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    altKey: options.altKey ?? false,
    target,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe("preventDialogDocumentSelectAll", () => {
  it("prevents page selection from non-text dialog surfaces", () => {
    const event = keyboardEvent(document.createElement("div"), { metaKey: true });

    expect(preventDialogDocumentSelectAll(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([document.createElement("input"), document.createElement("textarea")])("keeps native select-all for text controls", (target) => {
    const event = keyboardEvent(target, { ctrlKey: true });

    expect(preventDialogDocumentSelectAll(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps native select-all for nested textbox content", () => {
    const textbox = document.createElement("div");
    textbox.setAttribute("role", "textbox");
    const child = document.createElement("span");
    textbox.appendChild(child);
    const event = keyboardEvent(child, { metaKey: true });

    expect(preventDialogDocumentSelectAll(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("does not intercept ordinary typing", () => {
    const event = keyboardEvent(document.createElement("div"));

    expect(preventDialogDocumentSelectAll(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

function clipboardEvent(target: EventTarget) {
  return {
    target,
    preventDefault: vi.fn(),
    clipboardData: { setData: vi.fn() },
  } as unknown as ClipboardEvent;
}

function passwordInput(value: string, options: { masked?: boolean; marker?: boolean; selection?: [number, number] } = {}) {
  const input = document.createElement("input");
  input.type = options.masked === false ? "text" : "password";
  if (options.marker !== false) input.setAttribute("data-password-input", "");
  input.value = value;
  const [start, end] = options.selection ?? [value.length, value.length];
  input.setSelectionRange(start, end);
  return input;
}

describe("copyDialogPasswordFieldValue", () => {
  it("copies the whole revealed password when only the caret sits in the field", () => {
    const input = passwordInput("p^ss%40@x#y", { masked: false });
    const event = clipboardEvent(input);

    expect(copyDialogPasswordFieldValue(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect((event.clipboardData as unknown as { setData: ReturnType<typeof vi.fn> }).setData).toHaveBeenCalledWith("text/plain", "p^ss%40@x#y");
  });

  it("copies the whole password while the field is still masked", () => {
    const input = passwordInput("p^ss%40@x#y", { masked: true });
    const event = clipboardEvent(input);

    expect(copyDialogPasswordFieldValue(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("keeps the native substring copy when text is selected", () => {
    const input = passwordInput("p^ss%40@x#y", { masked: false, selection: [0, 4] });
    const event = clipboardEvent(input);

    expect(copyDialogPasswordFieldValue(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves other inputs and empty passwords alone", () => {
    const plain = passwordInput("app_user", { masked: false, marker: false });
    const plainEvent = clipboardEvent(plain);
    const empty = passwordInput("", { masked: false });
    const emptyEvent = clipboardEvent(empty);

    expect(copyDialogPasswordFieldValue(plainEvent)).toBe(false);
    expect(copyDialogPasswordFieldValue(emptyEvent)).toBe(false);
    expect(plainEvent.preventDefault).not.toHaveBeenCalled();
    expect(emptyEvent.preventDefault).not.toHaveBeenCalled();
  });
});
