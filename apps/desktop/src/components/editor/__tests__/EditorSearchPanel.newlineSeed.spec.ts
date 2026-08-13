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

describe("EditorSearchPanel openSearch selection seeding (issue #5435)", () => {
  it("seeds the search query with the full selection, newline included, so cross-line matches are found without manually typing \\n", async () => {
    // Document is exactly the selected text; a correctly seeded (newline-preserving)
    // search query must find exactly one match. An HTML <input> always strips \n
    // from its rendered value (browser sanitization), so we assert on the actual
    // search outcome (rendered match count) rather than the raw input DOM value.
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "line one\nline two" }),
    });
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });

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
    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    expect(host.textContent).toContain("1/1");
    expect(host.textContent).not.toContain("noResults");

    view.destroy();
  });
});
