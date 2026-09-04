// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { vNamingStyleSupport } from "../vNamingStyleSupport";

describe("vNamingStyleSupport directive", () => {
  it("converts selected text on Shift+Alt+C", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    // Mount directive
    vNamingStyleSupport.mounted!(input, {} as any, {} as any, null as any);

    // Set value and selection
    input.value = "user_name";
    input.setSelectionRange(0, 9);
    input.focus();

    // Simulate Shift+Alt+C
    const event = new KeyboardEvent("keydown", {
      key: "c",
      shiftKey: true,
      altKey: true,
      bubbles: true,
    });
    input.dispatchEvent(event);

    // snake_case → SCREAMING_SNAKE_CASE
    expect(input.value).toBe("USER_NAME");

    // Cleanup
    vNamingStyleSupport.unmounted!(input, {} as any, {} as any, null as any);
    document.body.removeChild(input);
  });

  it("converts entire input when no selection", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    vNamingStyleSupport.mounted!(input, {} as any, {} as any, null as any);

    input.value = "user_name";
    input.focus();

    const event = new KeyboardEvent("keydown", {
      key: "c",
      shiftKey: true,
      altKey: true,
      bubbles: true,
    });
    input.dispatchEvent(event);

    expect(input.value).toBe("USER_NAME");

    vNamingStyleSupport.unmounted!(input, {} as any, {} as any, null as any);
    document.body.removeChild(input);
  });

  it("cycles through naming styles", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    vNamingStyleSupport.mounted!(input, {} as any, {} as any, null as any);

    input.value = "userName";
    input.focus();

    const triggerConversion = () => {
      const event = new KeyboardEvent("keydown", {
        key: "c",
        shiftKey: true,
        altKey: true,
        bubbles: true,
      });
      input.dispatchEvent(event);
    };

    // camelCase → PascalCase
    triggerConversion();
    expect(input.value).toBe("UserName");

    // PascalCase → snake_case
    triggerConversion();
    expect(input.value).toBe("user_name");

    // snake_case → SCREAMING_SNAKE_CASE
    triggerConversion();
    expect(input.value).toBe("USER_NAME");

    // SCREAMING_SNAKE_CASE → kebab-case
    triggerConversion();
    expect(input.value).toBe("user-name");

    // kebab-case → camelCase
    triggerConversion();
    expect(input.value).toBe("userName");

    vNamingStyleSupport.unmounted!(input, {} as any, {} as any, null as any);
    document.body.removeChild(input);
  });
});
