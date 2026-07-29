// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DetachedWindowShell from "@/components/layout/DetachedWindowShell.vue";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ destroy: mocks.destroy }),
}));

afterEach(() => {
  document.body.innerHTML = "";
});

async function mountShell() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(DetachedWindowShell);
  app.mount(container);
  await nextTick();
  return { app, container };
}

describe("DetachedWindowShell", () => {
  it("renders a lightweight loading state before the full app is ready", async () => {
    const { app, container } = await mountShell();

    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading detached tab");
    expect(container.textContent).toContain("Loading tab");
    app.unmount();
  });

  it("force-destroys the window from the shell close button", async () => {
    mocks.destroy.mockClear();
    const { app, container } = await mountShell();

    container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    await nextTick();

    expect(mocks.destroy).toHaveBeenCalledOnce();
    app.unmount();
  });
});
