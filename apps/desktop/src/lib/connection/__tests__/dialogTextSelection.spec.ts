// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { preventDialogDocumentSelectAll } from "../dialogTextSelection";

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
