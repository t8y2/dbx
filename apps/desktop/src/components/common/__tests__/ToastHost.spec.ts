// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToastHost from "@/components/common/ToastHost.vue";
import { useToast } from "@/composables/useToast";

let app: App;
let root: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  const state = useToast();
  state.dismissToast();
  for (const entry of state.persistentMessages.value) state.dismissToast(entry.id);
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(ToastHost);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: { common: { close: "Close" } } } }));
  app.mount(root);
});

afterEach(() => {
  app.unmount();
  root.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("ToastHost", () => {
  it("keeps a failed operation visible until its close button is clicked", async () => {
    const { toast, persistentMessages } = useToast();
    toast("Cannot truncate a table referenced by a foreign key", { persistent: true });
    await nextTick();
    vi.advanceTimersByTime(30_000);
    await nextTick();

    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Cannot truncate");
    const closeButton = root.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(closeButton).not.toBeNull();
    closeButton!.click();
    await nextTick();

    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(persistentMessages.value).toEqual([]);
  });

  it("preserves independent errors while displaying a transient success notification", async () => {
    const { toast } = useToast();
    toast("First failure", { persistent: true });
    toast("Second failure", { persistent: true });
    toast("Copied", 2000);
    await nextTick();

    expect(root.querySelector('[role="status"]')?.textContent).toContain("Copied");
    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(2);
    root.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    await nextTick();
    vi.advanceTimersByTime(30_000);
    await nextTick();

    const alerts = root.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("First failure");
  });

  it("renders server error text safely and retains an optional action until dismissal", async () => {
    const onClick = vi.fn();
    useToast().toast('ERROR: <script>alert("untrusted")</script>\nDETAIL: foreign key dependency', { persistent: true }, { label: "View details", onClick });
    await nextTick();
    vi.advanceTimersByTime(30_000);
    await nextTick();

    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain('<script>alert("untrusted")</script>');
    const action = Array.from(root.querySelectorAll("button")).find((button) => button.textContent === "View details");
    expect(action).toBeDefined();
    action!.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
  });
});
