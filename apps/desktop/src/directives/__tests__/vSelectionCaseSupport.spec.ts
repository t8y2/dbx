// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { applySelectionCaseToInput, vSelectionCaseSupport } from "../vSelectionCaseSupport";

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
  vSelectionCaseSupport.mounted!(input, {} as any, {} as any, null as any);
  input.value = value;
  input.focus();
  return input;
}

function mountInputWrapper(value: string): { wrapper: HTMLDivElement; input: HTMLInputElement } {
  const wrapper = document.createElement("div");
  const input = document.createElement("input");
  input.type = "text";
  wrapper.appendChild(input);
  document.body.appendChild(wrapper);
  vSelectionCaseSupport.mounted!(wrapper, {} as any, {} as any, null as any);
  input.value = value;
  input.focus();
  return { wrapper, input };
}

function unmountInput(el: HTMLElement): void {
  vSelectionCaseSupport.unmounted!(el, {} as any, {} as any, null as any);
  el.remove();
}

function pressToggleCaseShortcut(input: HTMLInputElement, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "u",
    code: "KeyU",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  input.dispatchEvent(event);
  return event;
}

function pressUppercaseShortcut(input: HTMLInputElement, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "u",
    code: "KeyU",
    shiftKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  input.dispatchEvent(event);
  return event;
}

function pressLowercaseShortcut(input: HTMLInputElement, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "l",
    code: "KeyL",
    shiftKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  input.dispatchEvent(event);
  return event;
}

describe("vSelectionCaseSupport directive", () => {
  it("toggles case of selected text on Mod+Shift+U and preserves selection", () => {
    const input = mountInput("user_name");
    input.setSelectionRange(0, 9);

    const event1 = pressToggleCaseShortcut(input);
    expect(input.value).toBe("USER_NAME");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(9);
    expect(event1.defaultPrevented).toBe(true);

    const event2 = pressToggleCaseShortcut(input);
    expect(input.value).toBe("user_name");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(9);
    expect(event2.defaultPrevented).toBe(true);

    const event3 = pressToggleCaseShortcut(input);
    expect(input.value).toBe("USER_NAME");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(9);
    expect(event3.defaultPrevented).toBe(true);

    unmountInput(input);
  });

  it("toggles partial selection within a string and keeps selection around converted substring", () => {
    const input = mountInput("tbl_users_log");
    input.setSelectionRange(4, 9); // "users"

    pressToggleCaseShortcut(input);
    expect(input.value).toBe("tbl_USERS_log");
    expect(input.selectionStart).toBe(4);
    expect(input.selectionEnd).toBe(9);

    pressToggleCaseShortcut(input);
    expect(input.value).toBe("tbl_users_log");
    expect(input.selectionStart).toBe(4);
    expect(input.selectionEnd).toBe(9);

    unmountInput(input);
  });

  it("converts mixed case selection to uppercase first, then lowercase", () => {
    const input = mountInput("camelCase");
    input.setSelectionRange(0, 9);

    pressToggleCaseShortcut(input);
    expect(input.value).toBe("CAMELCASE");

    pressToggleCaseShortcut(input);
    expect(input.value).toBe("camelcase");

    pressToggleCaseShortcut(input);
    expect(input.value).toBe("CAMELCASE");

    unmountInput(input);
  });

  it("toggles entire input when there is no selection and preserves cursor position", () => {
    const input = mountInput("my_table");
    input.setSelectionRange(3, 3); // cursor after "my_"

    pressToggleCaseShortcut(input);
    expect(input.value).toBe("MY_TABLE");
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);

    pressToggleCaseShortcut(input);
    expect(input.value).toBe("my_table");
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);

    unmountInput(input);
  });

  it("converts selection to uppercase on Shift+Alt+U", () => {
    const input = mountInput("users");
    input.setSelectionRange(0, 5);

    pressUppercaseShortcut(input);
    expect(input.value).toBe("USERS");

    // Already uppercase: no change, keystroke not prevented
    const secondEvent = pressUppercaseShortcut(input);
    expect(input.value).toBe("USERS");
    expect(secondEvent.defaultPrevented).toBe(false);

    unmountInput(input);
  });

  it("converts selection to lowercase on Shift+Alt+L", () => {
    const input = mountInput("USERS");
    input.setSelectionRange(0, 5);

    pressLowercaseShortcut(input);
    expect(input.value).toBe("users");

    // Already lowercase: no change, keystroke not prevented
    const secondEvent = pressLowercaseShortcut(input);
    expect(input.value).toBe("users");
    expect(secondEvent.defaultPrevented).toBe(false);

    unmountInput(input);
  });

  it("matches macOS Command key for Mod shortcut", () => {
    const input = mountInput("users");
    input.setSelectionRange(0, 5);

    const macEvent = pressToggleCaseShortcut(input, {
      ctrlKey: false,
      metaKey: true,
    });

    expect(input.value).toBe("USERS");
    expect(macEvent.defaultPrevented).toBe(true);

    unmountInput(input);
  });

  it("follows custom shortcut settings instead of defaults", () => {
    shortcutState.shortcuts = { toggleCaseSelection: "Mod+Shift+K" };
    try {
      const input = mountInput("users");
      input.setSelectionRange(0, 5);

      // Default shortcut Mod+Shift+U should no longer trigger
      const defaultEvent = pressToggleCaseShortcut(input);
      expect(input.value).toBe("users");
      expect(defaultEvent.defaultPrevented).toBe(false);

      // Remapped shortcut Mod+Shift+K triggers
      const remappedEvent = pressToggleCaseShortcut(input, { key: "k", code: "KeyK" });
      expect(input.value).toBe("USERS");
      expect(remappedEvent.defaultPrevented).toBe(true);

      unmountInput(input);
    } finally {
      shortcutState.shortcuts = {};
    }
  });

  it("ignores shortcut when composing (IME active)", () => {
    const input = mountInput("users");
    input.setSelectionRange(0, 5);

    const event = pressToggleCaseShortcut(input, { isComposing: true });
    expect(input.value).toBe("users");
    expect(event.defaultPrevented).toBe(false);

    unmountInput(input);
  });

  it("does not trigger when unexpected modifier keys are held", () => {
    const input = mountInput("users");
    input.setSelectionRange(0, 5);

    const event = pressToggleCaseShortcut(input, { altKey: true });
    expect(input.value).toBe("users");
    expect(event.defaultPrevented).toBe(false);

    unmountInput(input);
  });

  it("does not mutate or prevent default for empty input or non-cased text", () => {
    const emptyInput = mountInput("");
    const emptyEvent = pressToggleCaseShortcut(emptyInput);
    expect(emptyInput.value).toBe("");
    expect(emptyEvent.defaultPrevented).toBe(false);
    unmountInput(emptyInput);

    const numberInput = mountInput("12345");
    numberInput.setSelectionRange(0, 5);
    const numberEvent = pressToggleCaseShortcut(numberInput);
    expect(numberInput.value).toBe("12345");
    expect(numberEvent.defaultPrevented).toBe(false);
    unmountInput(numberInput);

    const cjkInput = mountInput("用户表");
    cjkInput.setSelectionRange(0, 3);
    const cjkEvent = pressToggleCaseShortcut(cjkInput);
    expect(cjkInput.value).toBe("用户表");
    expect(cjkEvent.defaultPrevented).toBe(false);
    unmountInput(cjkInput);
  });

  it("dispatches an input event with bubbles: true to trigger v-model update", () => {
    const input = mountInput("orders");
    input.setSelectionRange(0, 6);

    let inputDispatched = false;
    input.addEventListener("input", (e) => {
      inputDispatched = true;
      expect(e.bubbles).toBe(true);
    });

    pressToggleCaseShortcut(input);
    expect(inputDispatched).toBe(true);
    expect(input.value).toBe("ORDERS");

    unmountInput(input);
  });

  it("works when mounted on a wrapper component element", () => {
    const { wrapper, input } = mountInputWrapper("customers");
    input.setSelectionRange(0, 9);

    pressToggleCaseShortcut(input);
    expect(input.value).toBe("CUSTOMERS");

    unmountInput(wrapper);
  });

  it("does not modify disabled or readonly inputs", () => {
    const input = mountInput("disabled_text");
    input.disabled = true;
    expect(applySelectionCaseToInput(input, "toggle")).toBe(false);
    expect(input.value).toBe("disabled_text");

    input.disabled = false;
    input.readOnly = true;
    expect(applySelectionCaseToInput(input, "toggle")).toBe(false);
    expect(input.value).toBe("disabled_text");

    unmountInput(input);
  });
});
