// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTabSwitcherKeyboardController } from "@/lib/tabs/tabSwitcherKeyboard";

function keyboardEvent(type: "keydown" | "keyup", key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
}

function createHarness(initialShortcut = "Ctrl+Tab") {
  let open = true;
  let shortcut = initialShortcut;
  const moves: Array<-1 | 1> = [];
  let commits = 0;
  let cancellations = 0;
  const controller = createTabSwitcherKeyboardController(
    {
      isOpen: () => open,
      shortcut: () => shortcut,
      move: (direction) => moves.push(direction),
      commit: () => {
        commits += 1;
        open = false;
      },
      cancel: () => {
        cancellations += 1;
        open = false;
      },
    },
    "Win32",
  );

  return {
    controller,
    moves,
    setOpen: (value: boolean) => {
      open = value;
    },
    setShortcut: (value: string) => {
      shortcut = value;
    },
    commits: () => commits,
    cancellations: () => cancellations,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tab switcher capture handling", () => {
  it.each([
    ["ArrowDown", "move", 1],
    ["ArrowUp", "move", -1],
    ["Enter", "commit", 0],
    ["Escape", "cancel", 0],
  ] as const)("handles %s even when the event was already prevented", (key, action, direction) => {
    const harness = createHarness();
    const event = keyboardEvent("keydown", key);
    event.preventDefault();

    expect(harness.controller.handleKeydownCapture(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    if (action === "move") expect(harness.moves).toEqual([direction]);
    if (action === "commit") expect(harness.commits()).toBe(1);
    if (action === "cancel") expect(harness.cancellations()).toBe(1);
  });

  it("captures navigation before a focused editor can prevent the event", () => {
    const harness = createHarness();
    const editor = document.createElement("div");
    const editorKeydown = vi.fn((event: KeyboardEvent) => event.preventDefault());
    editor.addEventListener("keydown", editorKeydown);
    document.body.append(editor);
    const capture = (event: KeyboardEvent) => harness.controller.handleKeydownCapture(event);
    window.addEventListener("keydown", capture, true);

    try {
      const event = keyboardEvent("keydown", "ArrowDown");
      editor.dispatchEvent(event);

      expect(harness.moves).toEqual([1]);
      expect(event.defaultPrevented).toBe(true);
      expect(editorKeydown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", capture, true);
    }
  });

  it("leaves unrelated keys available while the switcher is open", () => {
    const harness = createHarness();
    const event = keyboardEvent("keydown", "x");

    expect(harness.controller.handleKeydownCapture(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(harness.moves).toEqual([]);
  });
});

describe("tab switcher release conditions", () => {
  it.each([
    {
      shortcut: "Ctrl+Tab",
      opening: keyboardEvent("keydown", "Tab", { ctrlKey: true }),
      nonRelease: keyboardEvent("keyup", "Tab", { ctrlKey: true }),
      release: keyboardEvent("keyup", "Control"),
    },
    {
      shortcut: "Shift+Tab",
      opening: keyboardEvent("keydown", "Tab", { shiftKey: true }),
      nonRelease: keyboardEvent("keyup", "Tab", { shiftKey: true }),
      release: keyboardEvent("keyup", "Shift"),
    },
    {
      shortcut: "F6",
      opening: keyboardEvent("keydown", "F6"),
      nonRelease: keyboardEvent("keyup", "F5"),
      release: keyboardEvent("keyup", "F6"),
    },
  ])("commits $shortcut when its configured hold key is released", ({ shortcut, opening, nonRelease, release }) => {
    const harness = createHarness(shortcut);
    harness.controller.rememberOpeningEvent(opening);

    expect(harness.controller.handleKeyup(nonRelease)).toBe(false);
    expect(harness.commits()).toBe(0);
    expect(harness.controller.handleKeyup(release)).toBe(true);
    expect(harness.commits()).toBe(1);
  });
});

describe("tab switcher deactivation cleanup", () => {
  it("cancels on window blur and clears the previous release condition", () => {
    const harness = createHarness();
    harness.controller.rememberOpeningEvent(keyboardEvent("keydown", "Tab", { ctrlKey: true }));

    expect(harness.controller.handleWindowBlur()).toBe(true);
    expect(harness.cancellations()).toBe(1);
    harness.setOpen(true);
    expect(harness.controller.handleKeyup(keyboardEvent("keyup", "Control"))).toBe(false);
    expect(harness.commits()).toBe(0);
  });

  it("cancels when hidden but not when visibility remains visible", () => {
    const harness = createHarness("F6");
    harness.controller.rememberOpeningEvent(keyboardEvent("keydown", "F6"));

    expect(harness.controller.handleVisibilityChange("visible")).toBe(false);
    expect(harness.cancellations()).toBe(0);
    expect(harness.controller.handleVisibilityChange("hidden")).toBe(true);
    expect(harness.cancellations()).toBe(1);
    harness.setOpen(true);
    expect(harness.controller.handleKeyup(keyboardEvent("keyup", "F6"))).toBe(false);
    expect(harness.commits()).toBe(0);
  });
});
