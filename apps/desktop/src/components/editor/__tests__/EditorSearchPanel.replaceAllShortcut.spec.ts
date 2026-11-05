// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { search } from "@codemirror/search";
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

interface PanelInstance {
  openSearch: () => boolean;
  openReplace: () => boolean;
}

async function mountPanel(doc: string): Promise<{ host: HTMLElement; view: EditorView; instance: PanelInstance }> {
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({ doc, extensions: [search()] }),
  });
  let instance: PanelInstance | null = null;
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(EditorSearchPanel, {
            view,
            ref: (el) => {
              instance = el as unknown as PanelInstance;
            },
          });
      },
    }),
  );
  app.mount(host);
  mountedApps.push({ app, host });
  return { host, view, instance: instance! };
}

function searchInput(host: HTMLElement): HTMLInputElement {
  return host.querySelector<HTMLInputElement>(`input[placeholder="editor.search.find"]`)!;
}

function replaceInput(host: HTMLElement): HTMLInputElement {
  return host.querySelector<HTMLInputElement>(`input[placeholder="editor.search.replace"]`)!;
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function keydown(input: HTMLInputElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(event);
  return event;
}

async function openPanelWithReplace(host: HTMLElement, instance: PanelInstance, find: string, replace: string) {
  instance.openReplace();
  await nextTick();
  typeInto(searchInput(host), find);
  typeInto(replaceInput(host), replace);
  // Let the searchText/replaceText watchers run dispatchSearchQuery so the
  // CodeMirror search state (which cmReplaceAll/cmReplaceNext read) carries
  // the panel's current query before the keydown fires.
  await nextTick();
}

describe("EditorSearchPanel Ctrl+Alt+Enter replace all", () => {
  it("replaces every match from the replace input", async () => {
    const { host, view, instance } = await mountPanel("foo bar foo baz foo");
    await openPanelWithReplace(host, instance, "foo", "qux");

    keydown(replaceInput(host), { ctrlKey: true, altKey: true });

    expect(view.state.doc.toString()).toBe("qux bar qux baz qux");
    view.destroy();
  });

  it("replaces every match from the search input while the replace row is expanded", async () => {
    const { host, view, instance } = await mountPanel("foo bar foo");
    await openPanelWithReplace(host, instance, "foo", "qux");

    const event = keydown(searchInput(host), { ctrlKey: true, altKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("qux bar qux");
    view.destroy();
  });

  it("swallows the combo without replacing while the replace row is collapsed, and plain Enter still finds the next match", async () => {
    const { host, view, instance } = await mountPanel("foo bar foo");
    instance.openSearch();
    await nextTick();
    expect(replaceInput(host)).toBeNull();
    typeInto(searchInput(host), "foo");
    await nextTick();

    const combo = keydown(searchInput(host), { ctrlKey: true, altKey: true });
    expect(combo.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("foo bar foo");

    keydown(searchInput(host), {});
    const selection = view.state.selection.main;
    expect(view.state.sliceDoc(selection.from, selection.to)).toBe("foo");
    view.destroy();
  });

  it("keeps plain Enter in the replace input as replace-one", async () => {
    const { host, view, instance } = await mountPanel("foo bar foo");
    await openPanelWithReplace(host, instance, "foo", "qux");
    // replaceNext replaces the match the selection covers; with the panel
    // freshly opened (empty selection) the first Enter only selects the next
    // match, which is exactly how the button behaved before.
    view.dispatch({ selection: { anchor: 0, head: 3 } });

    keydown(replaceInput(host), {});

    expect(view.state.doc.toString()).toBe("qux bar foo");
    view.destroy();
  });

  it("keeps Escape closing the panel from the replace input", async () => {
    const { host, view, instance } = await mountPanel("foo bar");
    await openPanelWithReplace(host, instance, "foo", "qux");

    keydown(replaceInput(host), { key: "Escape" });
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();

    expect(host.querySelector(`input[placeholder="editor.search.find"]`)).toBeNull();
    view.destroy();
  });
});
