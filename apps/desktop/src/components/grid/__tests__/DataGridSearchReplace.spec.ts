// @vitest-environment happy-dom
import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DataGridSearchBar from "../DataGridSearchBar.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// Keydown into the bar's inputs runs the v-naming-style-support directive,
// which reads the settings store outside a Pinia app.
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { shortcuts: {}, regexMaxMatchCount: 1000 } }),
}));
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

function mountBar(overrides: Record<string, unknown> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const replaceAll = vi.fn();
  const replaceCurrent = vi.fn();
  const changeText = vi.fn();
  const changeScope = vi.fn();
  const changeCase = vi.fn();
  const app = createApp({
    render: () =>
      h(DataGridSearchBar, {
        open: true,
        suggestions: [],
        suggestionIndex: -1,
        matchCount: 2,
        currentMatchIndex: 0,
        hasDeferredSearchText: true,
        replaceOpen: true,
        replaceAvailable: true,
        replaceMatchCount: 2,
        canReplaceCurrent: true,
        columns: ["first", "paths"],
        onReplaceAll: replaceAll,
        onReplaceCurrent: replaceCurrent,
        "onUpdate:replacementText": changeText,
        "onUpdate:replaceScope": changeScope,
        "onUpdate:caseSensitive": changeCase,
        ...overrides,
      }),
  });
  app.mount(root);
  cleanup.push(() => {
    app.unmount();
    root.remove();
  });
  return { root, replaceAll, replaceCurrent, changeText, changeScope, changeCase };
}

describe("DataGridSearchBar replacement controls", () => {
  it("emits literal empty replacement input, scope and case choices and replacement commands", async () => {
    const bar = mountBar();
    const input = bar.root.querySelector<HTMLInputElement>("[data-grid-replacement-input]")!;
    expect(input).not.toBeNull();
    input.value = "$&";
    input.dispatchEvent(new Event("input"));
    expect(bar.changeText).toHaveBeenCalledWith("$&");
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(bar.changeText).toHaveBeenLastCalledWith("");
    const scope = bar.root.querySelector<HTMLSelectElement>("[data-grid-replace-scope]")!;
    scope.value = "selection";
    scope.dispatchEvent(new Event("change"));
    expect(bar.changeScope).toHaveBeenCalledWith("selection");
    bar.root.querySelector<HTMLButtonElement>("[data-grid-replace-case]")!.click();
    expect(bar.changeCase).toHaveBeenCalledWith(true);
    bar.root.querySelector<HTMLButtonElement>("[data-grid-replace-all]")!.click();
    bar.root.querySelector<HTMLButtonElement>("[data-grid-replace-current]")!.click();
    expect(bar.replaceAll).toHaveBeenCalledOnce();
    expect(bar.replaceCurrent).toHaveBeenCalledOnce();
    await nextTick();
  });

  it("disables replacement for readonly/busy results and does not expose it in search-only hosts", () => {
    const readonly = mountBar({ replaceAvailable: false });
    const button = readonly.root.querySelector<HTMLButtonElement>("[data-grid-replace-all]")!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(readonly.replaceAll).not.toHaveBeenCalled();
    const busy = mountBar({ replaceBusy: true });
    expect(busy.root.querySelector<HTMLButtonElement>("[data-grid-replace-all]")!.disabled).toBe(true);
    const empty = mountBar({ replaceMatchCount: 0, canReplaceCurrent: false });
    expect(empty.root.querySelector<HTMLButtonElement>("[data-grid-replace-all]")!.disabled).toBe(true);
    const searchOnly = mountBar({ replaceOpen: false, replaceAvailable: undefined });
    expect(searchOnly.root.querySelector("[data-grid-replacement-input]")).toBeNull();
    expect(searchOnly.root.querySelector("[data-grid-replace-toggle]")).toBeNull();
  });
});

describe("DataGridSearchBar Ctrl+Alt+Enter replace all", () => {
  function pressCombo(target: HTMLElement, init: KeyboardEventInit = { ctrlKey: true, altKey: true }) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
  }

  it("emits replaceAll from the replacement input instead of replaceCurrent", () => {
    const bar = mountBar();
    const input = bar.root.querySelector<HTMLInputElement>("[data-grid-replacement-input]")!;
    pressCombo(input);
    expect(bar.replaceAll).toHaveBeenCalledOnce();
    expect(bar.replaceCurrent).not.toHaveBeenCalled();
    expect(bar.root.querySelector<HTMLButtonElement>("[data-grid-replace-all]")!.title).toContain("editor.search.replaceAll");
  });

  it("emits replaceAll from the search input without forwarding the combo as a keydown, and still forwards plain Enter", () => {
    const keydown = vi.fn();
    const bar = mountBar({ onKeydown: keydown });
    const input = bar.root.querySelector<HTMLInputElement>("input[type='search']")!;
    pressCombo(input);
    expect(bar.replaceAll).toHaveBeenCalledOnce();
    expect(keydown).not.toHaveBeenCalled();
    pressCombo(input, {});
    expect(keydown).toHaveBeenCalledOnce();
  });

  it("keeps plain Enter in the replacement input as replaceCurrent", () => {
    const bar = mountBar();
    const input = bar.root.querySelector<HTMLInputElement>("[data-grid-replacement-input]")!;
    pressCombo(input, {});
    expect(bar.replaceCurrent).toHaveBeenCalledOnce();
    expect(bar.replaceAll).not.toHaveBeenCalled();
  });

  it("honors the Replace All button gates and ignores the combo with the replace row collapsed", () => {
    const busy = mountBar({ replaceBusy: true });
    pressCombo(busy.root.querySelector<HTMLInputElement>("[data-grid-replacement-input]")!);
    expect(busy.replaceAll).not.toHaveBeenCalled();

    const noMatches = mountBar({ replaceMatchCount: 0 });
    pressCombo(noMatches.root.querySelector<HTMLInputElement>("[data-grid-replacement-input]")!);
    expect(noMatches.replaceAll).not.toHaveBeenCalled();

    const readonly = mountBar({ replaceAvailable: false });
    pressCombo(readonly.root.querySelector<HTMLInputElement>("input[type='search']")!);
    expect(readonly.replaceAll).not.toHaveBeenCalled();

    const collapsed = mountBar({ replaceOpen: false });
    pressCombo(collapsed.root.querySelector<HTMLInputElement>("input[type='search']")!);
    expect(collapsed.replaceAll).not.toHaveBeenCalled();
  });
});
