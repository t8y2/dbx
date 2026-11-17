// @vitest-environment happy-dom

import { createApp, nextTick, reactive, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConsoleTerminal from "@/components/console/ConsoleTerminal.vue";
import type { QueryTab } from "@/types/database";
import type { ConsoleEntry } from "@/lib/console/consoleFormat";

const mocks = vi.hoisted(() => ({ consoleSessionFor: vi.fn(), cancelConsoleStatement: vi.fn(), executeConsoleStatement: vi.fn(), consoleHistoryNavigate: vi.fn(), copyToClipboard: vi.fn(), readTextFromClipboard: vi.fn(), hasNativeClipboardSelection: vi.fn() }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => mocks }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => ({ id: "oracle-1", db_type: "oracle" }) }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: mocks.copyToClipboard, readTextFromClipboard: mocks.readTextFromClipboard, hasNativeClipboardSelection: mocks.hasNativeClipboardSelection }));

const mounted: Array<{ app: App; container: HTMLDivElement }> = [];

async function mountRunningConsole(running = true) {
  const session = reactive({ entries: [] as ConsoleEntry[], input: "", buffer: "", isExecuting: running });
  mocks.consoleSessionFor.mockReturnValue(session);
  const tab = reactive<QueryTab>({ id: "console-1", title: "Console", connectionId: "oracle-1", database: "ORCL", sql: "", mode: "console", isExecuting: true });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(ConsoleTerminal, { tab });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: { console: { title: "Console", running: "running", copy: "Copy", paste: "Paste", clipboardFailed: "Clipboard operation failed: {message}" }, toolbar: { stopQuery: "Stop query" } } } }));
  app.mount(container);
  mounted.push({ app, container });
  await nextTick();
  return { container, session, tab };
}

function menuAction(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((button) => button.textContent?.trim().startsWith(label))!;
}

describe("ConsoleTerminal cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasNativeClipboardSelection.mockReturnValue(false);
    mocks.copyToClipboard.mockResolvedValue(undefined);
  });
  afterEach(() => {
    for (const { app, container } of mounted.splice(0)) {
      app.unmount();
      container.remove();
    }
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  it("keeps the running input focusable so Ctrl+C can cancel", async () => {
    const { container } = await mountRunningConsole();
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute("aria-label")).toBe("Console");
    input.focus();
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(mocks.cancelConsoleStatement).toHaveBeenCalledWith("console-1");
  });

  it("leaves macOS Command+C and Command+V to native input clipboard handling", async () => {
    const { container } = await mountRunningConsole();
    const input = container.querySelector<HTMLInputElement>("input")!;
    for (const key of ["c", "v"]) {
      const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(mocks.cancelConsoleStatement).not.toHaveBeenCalled();
  });

  it("offers a visible stop button and disables duplicate cancellation", async () => {
    const { container, tab, session } = await mountRunningConsole();
    const button = container.querySelector<HTMLButtonElement>("[data-console-cancel]")!;
    expect(button.textContent).toContain("Stop query");
    button.click();
    expect(mocks.cancelConsoleStatement).toHaveBeenCalledOnce();
    tab.isCancelling = true;
    await nextTick();
    expect(button.disabled).toBe(true);
    session.isExecuting = false;
    await nextTick();
    expect(container.querySelector("[data-console-cancel]")).toBeNull();
    expect(container.querySelector<HTMLInputElement>("input")?.readOnly).toBe(false);
  });

  it("does not submit another command while a query is running", async () => {
    const { container } = await mountRunningConsole();
    container.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(mocks.executeConsoleStatement).not.toHaveBeenCalled();
  });

  it("offers paste and copy actions on the input right-click menu", async () => {
    mocks.readTextFromClipboard.mockResolvedValue("SELECT 1;");
    const { container } = await mountRunningConsole(false);
    const input = container.querySelector<HTMLInputElement>("input")!;
    input.value = "SELECT";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    input.setSelectionRange(0, 6);
    input.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector("[data-dbx-context-menu]")).not.toBeNull();
    input.setSelectionRange(0, 0);
    menuAction("Copy").click();
    expect(mocks.copyToClipboard).toHaveBeenCalledWith("SELECT");

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await nextTick();
    menuAction("Paste").click();
    await vi.waitFor(() => expect(mocks.readTextFromClipboard).toHaveBeenCalledOnce());
    await nextTick();
    expect(input.value).toBe("SELECT 1;");
    expect(mocks.executeConsoleStatement).not.toHaveBeenCalled();
  });

  it("allows selecting output and copying the selected text from its context menu", async () => {
    const { container, session } = await mountRunningConsole();
    session.entries.push({ kind: "output", text: "server output" });
    await nextTick();
    const output = container.querySelector("[data-console-scrollback]")!;
    const range = document.createRange();
    range.selectNodeContents(output.firstElementChild!);
    window.getSelection()!.addRange(range);
    expect(output.classList.contains("select-text")).toBe(true);
    expect(output.hasAttribute("data-native-clipboard")).toBe(true);
    container.querySelector<HTMLInputElement>("input")!.blur();
    output.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.activeElement).not.toBe(container.querySelector("input"));
    output.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await nextTick();
    window.getSelection()!.removeAllRanges();
    menuAction("Copy").click();
    expect(mocks.copyToClipboard.mock.calls[0][0].trim()).toBe("server output");
  });

  it("copies selected text with Ctrl+C instead of cancelling or clearing", async () => {
    const { container } = await mountRunningConsole();
    const input = container.querySelector<HTMLInputElement>("input")!;
    mocks.hasNativeClipboardSelection.mockReturnValue(true);
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(mocks.cancelConsoleStatement).not.toHaveBeenCalled();
  });

  it("disables paste during execution and dismisses the menu on Escape", async () => {
    const { container } = await mountRunningConsole();
    container.querySelector("input")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(menuAction("Paste").disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(document.querySelector("[data-dbx-context-menu]")).toBeNull();
  });

  it("reports clipboard access failures instead of silently ignoring paste", async () => {
    mocks.readTextFromClipboard.mockRejectedValue(new Error("access denied"));
    const { container, session } = await mountRunningConsole(false);
    container.querySelector("input")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await nextTick();
    menuAction("Paste").click();
    await vi.waitFor(() => expect(session.entries.at(-1)).toMatchObject({ kind: "error", text: "Clipboard operation failed: access denied" }));
  });
});
