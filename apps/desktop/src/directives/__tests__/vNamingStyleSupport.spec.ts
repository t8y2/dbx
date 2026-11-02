// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { vNamingStyleSupport } from "../vNamingStyleSupport";

const shortcutState = vi.hoisted(() => ({
  shortcuts: {} as Record<string, string>,
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { shortcuts: shortcutState.shortcuts } }),
}));

function mountInput(value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  document.body.appendChild(input);
  vNamingStyleSupport.mounted!(input, {} as any, {} as any, null as any);
  input.value = value;
  input.focus();
  return input;
}

function unmountInput(input: HTMLInputElement): void {
  vNamingStyleSupport.unmounted!(input, {} as any, {} as any, null as any);
  document.body.removeChild(input);
}

function pressNamingStyleShortcut(input: HTMLInputElement, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "c",
    code: "KeyC",
    shiftKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  input.dispatchEvent(event);
  return event;
}

describe("vNamingStyleSupport directive", () => {
  it("converts selected text on Shift+Alt+C", () => {
    const input = mountInput("user_name");
    input.setSelectionRange(0, 9);

    pressNamingStyleShortcut(input);

    // snake_case → SCREAMING_SNAKE_CASE
    expect(input.value).toBe("USER_NAME");

    unmountInput(input);
  });

  it("converts entire input when no selection", () => {
    const input = mountInput("user_name");

    pressNamingStyleShortcut(input);

    expect(input.value).toBe("USER_NAME");

    unmountInput(input);
  });

  it("cycles through naming styles", () => {
    const input = mountInput("userName");

    // camelCase → PascalCase
    pressNamingStyleShortcut(input);
    expect(input.value).toBe("UserName");

    // PascalCase → snake_case
    pressNamingStyleShortcut(input);
    expect(input.value).toBe("user_name");

    // snake_case → SCREAMING_SNAKE_CASE
    pressNamingStyleShortcut(input);
    expect(input.value).toBe("USER_NAME");

    // SCREAMING_SNAKE_CASE → kebab-case
    pressNamingStyleShortcut(input);
    expect(input.value).toBe("user-name");

    // kebab-case → camelCase
    pressNamingStyleShortcut(input);
    expect(input.value).toBe("userName");

    unmountInput(input);
  });

  it("matches the physical key on macOS composed characters (⌥⇧C → Ç)", () => {
    const input = mountInput("userName");

    const event = pressNamingStyleShortcut(input, { key: "Ç" });

    expect(input.value).toBe("UserName");
    expect(event.defaultPrevented).toBe(true);

    unmountInput(input);
  });

  it("follows the shortcut configured in settings instead of the default", () => {
    shortcutState.shortcuts = { convertNamingStyle: "Shift+Alt+N" };
    try {
      const input = mountInput("userName");

      // Default Shift+Alt+C no longer triggers.
      const defaultEvent = pressNamingStyleShortcut(input);
      expect(input.value).toBe("userName");
      expect(defaultEvent.defaultPrevented).toBe(false);

      // The remapped Shift+Alt+N does.
      const remappedEvent = pressNamingStyleShortcut(input, { key: "n", code: "KeyN" });
      expect(input.value).toBe("UserName");
      expect(remappedEvent.defaultPrevented).toBe(true);

      unmountInput(input);
    } finally {
      shortcutState.shortcuts = {};
    }
  });

  it("does not trigger when Ctrl or Meta is also held", () => {
    const input = mountInput("userName");

    const withCtrl = pressNamingStyleShortcut(input, { ctrlKey: true });
    expect(input.value).toBe("userName");
    expect(withCtrl.defaultPrevented).toBe(false);

    const withMeta = pressNamingStyleShortcut(input, { metaKey: true });
    expect(input.value).toBe("userName");
    expect(withMeta.defaultPrevented).toBe(false);

    unmountInput(input);
  });

  it("lets the keystroke through when the content is not a single identifier", () => {
    const input = mountInput("price - discount");

    const event = pressNamingStyleShortcut(input);

    expect(input.value).toBe("price - discount");
    expect(event.defaultPrevented).toBe(false);

    unmountInput(input);
  });

  it("preserves surrounding whitespace when converting the whole input", () => {
    const input = mountInput("  userName  ");

    pressNamingStyleShortcut(input);

    expect(input.value).toBe("  UserName  ");

    unmountInput(input);
  });
});
