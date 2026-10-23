// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { regexMaxMatchCount: 1000 },
  }),
}));

import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.useRealTimers();
});

function toggleButton(host: HTMLElement, title: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.getAttribute("title") === title);
  if (!button) throw new Error(`missing button titled ${title}`);
  return button as HTMLButtonElement;
}

// `hover:bg-accent` also contains "bg-accent", so compare class tokens.
function isActive(button: HTMLButtonElement): boolean {
  return button.classList.contains("bg-accent");
}

describe("EditorSearchPanel whole-word toggle (#13287)", () => {
  it("narrows literal searches to whole words, greys itself out in regex mode, and keeps its state across regex toggles", async () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "id user_id order_id identity valid" }),
    });

    let instance: { openSearch: () => boolean } | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(EditorSearchPanel, {
              view,
              ref: (el) => {
                instance = el as unknown as { openSearch: () => boolean };
              },
            });
        },
      }),
    );
    app.mount(host);
    mountedApps.push({ app, host });

    instance!.openSearch();
    await nextTick();

    const input = host.querySelector("input") as HTMLInputElement;
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    // Plain literal search keeps the substring behavior: id/user_id/order_id/identity/valid.
    expect(host.textContent).toContain("1/5");

    const wholeWordButton = toggleButton(host, "editor.search.wholeWord");
    expect(wholeWordButton.disabled).toBe(false);
    wholeWordButton.click();
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    expect(host.textContent).toContain("1/1");
    expect(isActive(wholeWordButton)).toBe(true);

    // Regex mode disables the toggle and ignores it; the search falls back to plain regex.
    const regexButton = toggleButton(host, "editor.search.regex");
    regexButton.click();
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    expect(wholeWordButton.disabled).toBe(true);
    expect(isActive(wholeWordButton)).toBe(false);
    // Back to plain regex results: the current index may have advanced, so pin the total only.
    expect(host.textContent).toContain("/5");

    // Turning regex back off restores the user's whole-word choice.
    regexButton.click();
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    expect(wholeWordButton.disabled).toBe(false);
    expect(host.textContent).toContain("1/1");

    view.destroy();
  });
});
