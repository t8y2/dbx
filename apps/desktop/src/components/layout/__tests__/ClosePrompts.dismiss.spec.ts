// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type Component } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import AiRunsClosePromptDialog from "../AiRunsClosePromptDialog.vue";
import BackgroundTasksClosePromptDialog from "../BackgroundTasksClosePromptDialog.vue";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function settle() {
  await nextTick();
  await nextTick();
  await nextTick();
}

function mountPrompt(component: Component) {
  const open = ref(true);
  const pendingClose = ref(true);
  const cancel = vi.fn(() => {
    pendingClose.value = false;
    open.value = false;
  });
  const quit = vi.fn(() => {
    open.value = false;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    setup: () => () =>
      h(component, {
        open: open.value,
        count: 1,
        "onUpdate:open": (value: boolean) => {
          open.value = value;
        },
        onCancel: cancel,
        onQuit: quit,
      }),
  });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  return { open, pendingClose, cancel, quit };
}

describe.each([
  ["AI runs", AiRunsClosePromptDialog],
  ["background tasks", BackgroundTasksClosePromptDialog],
] as const)("%s exit confirmation", (_name, component) => {
  it.each(["dismiss", "escape", "cancel"])("cancels the pending close via %s", async (method) => {
    const { open, pendingClose, cancel, quit } = mountPrompt(component);
    await settle();
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog).not.toBeNull();
    if (method === "escape") dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else if (method === "dismiss") dialog.querySelector<HTMLButtonElement>("[data-slot='dialog-close']")!.click();
    else [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "common.cancel")!.click();
    await settle();
    expect(open.value).toBe(false);
    expect(pendingClose.value).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it("keeps an explicit quit separate from cancellation", async () => {
    const { open, cancel, quit } = mountPrompt(component);
    await settle();
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.endsWith("Quit"))!.click();
    await settle();
    expect(open.value).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
});
