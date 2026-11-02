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

async function mountPanel(doc: string) {
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({ doc }),
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
  return { host, view };
}

function wordToggle(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`button[title="editor.search.wholeWord"]`);
  if (!button) throw new Error("whole-word toggle is missing from the find panel");
  return button;
}

describe("EditorSearchPanel whole-word toggle (issue #13287)", () => {
  it("narrows a literal search from every substring hit to whole words only", async () => {
    const { host, view } = await mountPanel("user_id, id, identity");

    const input = host.querySelector<HTMLInputElement>("input")!;
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();
    // Substring search hits user_id, id and identity.
    expect(host.textContent).toContain("1/3");

    wordToggle(host).click();
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    expect(wordToggle(host).classList.contains("bg-accent")).toBe(true);
    expect(host.textContent).toContain("1/1");

    view.destroy();
  });

  it("keeps the toggle off by default so existing searches are unchanged", async () => {
    const { host, view } = await mountPanel("identity");

    expect(wordToggle(host).classList.contains("bg-accent")).toBe(false);

    const input = host.querySelector<HTMLInputElement>("input")!;
    input.value = "id";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    expect(host.textContent).toContain("1/1");

    view.destroy();
  });
});
