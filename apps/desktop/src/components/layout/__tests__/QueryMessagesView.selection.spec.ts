// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import QueryMessagesView from "../QueryMessagesView.vue";
import { eventTargetAllowsNativeClipboard, shouldBlockAppNativeSelectAll } from "@/lib/common/clipboard";
import type { QueryMessage } from "@/types/database";

const cleanups: Array<() => void> = [];
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

async function mountMessages(messages: QueryMessage[]) {
  const host = document.createElement("div");
  const editor = document.createElement("pre");
  editor.textContent = "SQL editor outside the messages";
  document.body.append(editor, host);
  const app = createApp(QueryMessagesView, { messages });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  await nextTick();
  const region = host.querySelector<HTMLElement>("[data-native-clipboard]")!;
  cleanups.push(() => {
    app.unmount();
    host.remove();
    editor.remove();
  });
  return { region, host };
}

describe("query message text selection", () => {
  it.each(["ctrlKey", "metaKey"])("selects every message with %s+A despite the app capture guard", async (modifier) => {
    const output = `start\n${"long procedure output\n".repeat(500)}end`;
    const { region } = await mountMessages([
      { severity: "INFO", message: output },
      { severity: "WARNING", message: "second message", detail: "detail", hint: "hint" },
    ]);
    const guard = (event: KeyboardEvent) => {
      if (shouldBlockAppNativeSelectAll(event)) event.preventDefault();
    };
    window.addEventListener("keydown", guard, true);
    cleanups.push(() => window.removeEventListener("keydown", guard, true));

    const text = region.querySelector(".text-foreground")!;
    text.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(document.activeElement).toBe(region);
    const selectAll = new KeyboardEvent("keydown", { key: "a", [modifier]: true, bubbles: true, cancelable: true });
    region.dispatchEvent(selectAll);

    const selection = window.getSelection()!;
    expect(selectAll.defaultPrevented).toBe(true);
    expect(selection.toString()).toContain(output);
    expect(selection.toString()).toContain("second message");
    expect(selection.toString()).toContain("detail");
    expect(selection.toString()).toContain("hint");
    expect(selection.toString()).not.toContain("SQL editor outside the messages");
    expect(region.contains(selection.anchorNode)).toBe(true);
    expect(region.contains(selection.focusNode)).toBe(true);

    const copy = new KeyboardEvent("keydown", { key: "c", [modifier]: true, bubbles: true, cancelable: true });
    region.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
    expect(eventTargetAllowsNativeClipboard(copy)).toBe(true);
  });

  it("leaves other keys and modified select-all combinations untouched", async () => {
    const { region } = await mountMessages([{ severity: "INFO", message: "output" }]);
    for (const options of [{ key: "a" }, { key: "a", ctrlKey: true, shiftKey: true }, { key: "a", ctrlKey: true, altKey: true }, { key: "f", ctrlKey: true }]) {
      const event = new KeyboardEvent("keydown", { ...options, bubbles: true, cancelable: true });
      region.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("keeps copy buttons focusable and preserves the native context menu", async () => {
    const { region } = await mountMessages([{ severity: "INFO", code: "mongo-shell", message: "db.collection.find()" }]);
    const button = region.querySelector("button")!;
    button.focus();
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(document.activeElement).toBe(button);
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    region.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
  });
});
