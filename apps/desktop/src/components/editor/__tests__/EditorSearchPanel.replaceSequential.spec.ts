// @vitest-environment happy-dom

import { EditorSelection, EditorState } from "@codemirror/state";
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

async function mountPanel(doc: string, selection?: { from: number; to: number }) {
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      selection: selection ? EditorSelection.single(selection.from, selection.to) : undefined,
    }),
  });

  let instance: { openSearch: () => boolean; openReplace: () => boolean } | null = null;
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(EditorSearchPanel, {
            view,
            ref: (el) => {
              instance = el as unknown as { openSearch: () => boolean; openReplace: () => boolean };
            },
          });
      },
    }),
  );
  app.mount(host);
  mountedApps.push({ app, host });

  instance!.openReplace();
  await nextTick();
  return { host, view, instance: instance! };
}

function getReplaceButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`button[title="editor.search.replace"]`);
  if (!button) throw new Error("replace button not found");
  return button;
}

describe("EditorSearchPanel sequential replace (issue #13724)", () => {
  it("replaces matches in strict sequential order without skipping", async () => {
    // 5 matches of "a": at indices 0..1, 2..3, 4..5, 6..7, 8..9
    const { host, view } = await mountPanel("a a a a a");

    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    const searchInput = inputs[0]!;
    const replaceInput = inputs[1]!;

    searchInput.value = "a";
    searchInput.dispatchEvent(new Event("input"));
    replaceInput.value = "b";
    replaceInput.dispatchEvent(new Event("input"));

    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    // Initially, 1/5 is selected (first "a" at 0..1)
    expect(host.textContent).toContain("1/5");
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(1);

    const replaceBtn = getReplaceButton(host);

    // Replace 1st match: "a" at 0..1 -> "b"
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("b a a a a");
    // The 2nd match (at 2..3) must now be selected, NOT skipped to the 3rd match!
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(3);
    expect(host.textContent).toContain("1/4");

    // Replace 2nd match: "a" at 2..3 -> "b"
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("b b a a a");
    // The 3rd match (at 4..5) must now be selected!
    expect(view.state.selection.main.from).toBe(4);
    expect(view.state.selection.main.to).toBe(5);
    expect(host.textContent).toContain("1/3");

    // Replace 3rd match: "a" at 4..5 -> "b"
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("b b b a a");
    expect(view.state.selection.main.from).toBe(6);
    expect(view.state.selection.main.to).toBe(7);
    expect(host.textContent).toContain("1/2");

    // Replace 4th match: "a" at 6..7 -> "b"
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("b b b b a");
    expect(view.state.selection.main.from).toBe(8);
    expect(view.state.selection.main.to).toBe(9);
    expect(host.textContent).toContain("1/1");

    // Replace 5th match: "a" at 8..9 -> "b"
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("b b b b b");

    view.destroy();
  });

  it("selects first match on replace click when nothing was previously selected", async () => {
    const { host, view } = await mountPanel("a a a");

    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    const searchInput = inputs[0]!;
    const replaceInput = inputs[1]!;

    searchInput.value = "a";
    searchInput.dispatchEvent(new Event("input"));
    replaceInput.value = "b";
    replaceInput.dispatchEvent(new Event("input"));

    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    // Move cursor away so no match is selected
    view.dispatch({ selection: EditorSelection.cursor(1) });
    expect(view.state.selection.main.empty).toBe(true);

    const replaceBtn = getReplaceButton(host);

    // Clicking replace when cursor is not matching selects the next match (at 2..3) without replacing yet
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("a a a");
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(3);

    // Clicking replace now replaces the selected match (2..3) and selects the next (4..5)
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("a b a");
    expect(view.state.selection.main.from).toBe(4);
    expect(view.state.selection.main.to).toBe(5);

    view.destroy();
  });

  it("replaces scoped matches sequentially within multiline selection", async () => {
    // Multi-line selection sets inSelectionScope
    // doc: "prefix\na\na\na\nsuffix"
    // "a\na\na" starts at 7 and ends at 12 (7..12 contains newlines!)
    const doc = "prefix\na\na\na\nsuffix";
    const { host, view } = await mountPanel(doc, { from: 7, to: 12 });

    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    const searchInput = inputs[0]!;
    const replaceInput = inputs[1]!;

    searchInput.value = "a";
    searchInput.dispatchEvent(new Event("input"));
    replaceInput.value = "b";
    replaceInput.dispatchEvent(new Event("input"));

    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();

    expect(host.textContent).toContain("editor.search.inSelection");

    const replaceBtn = getReplaceButton(host);

    // Initial match at 7..8 is already selected by search initialization
    expect(view.state.selection.main.from).toBe(7);
    expect(view.state.selection.main.to).toBe(8);

    // 1st click: replaces 7..8 with 'b', selects next match at 9..10
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("prefix\nb\na\na\nsuffix");
    expect(view.state.selection.main.from).toBe(9);
    expect(view.state.selection.main.to).toBe(10);

    // 2nd click: replaces 9..10 with 'b', selects next match at 11..12
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("prefix\nb\nb\na\nsuffix");
    expect(view.state.selection.main.from).toBe(11);
    expect(view.state.selection.main.to).toBe(12);

    // 3rd click: replaces 11..12 with 'b'
    replaceBtn.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("prefix\nb\nb\nb\nsuffix");

    view.destroy();
  });
});
