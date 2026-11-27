// @vitest-environment happy-dom
import { createApp, h } from "vue";
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

function mountBar() {
  const root = document.createElement("div");
  document.body.append(root);
  const keydown = vi.fn();
  const close = vi.fn();
  const replaceCurrent = vi.fn();
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
        columns: ["first"],
        onKeydown: keydown,
        onClose: close,
        onReplaceCurrent: replaceCurrent,
      }),
  });
  app.mount(root);
  cleanup.push(() => {
    app.unmount();
    root.remove();
  });
  return {
    search: root.querySelector<HTMLInputElement>("input[type=search]")!,
    replacement: root.querySelector<HTMLInputElement>("[data-grid-replacement-input]")!,
    keydown,
    close,
    replaceCurrent,
  };
}

function press(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** WebKit ends the composition, then dispatches the Enter that committed it. */
function commitComposition(target: EventTarget) {
  target.dispatchEvent(new Event("compositionstart"));
  target.dispatchEvent(new Event("compositionend"));
}

describe("DataGridSearchBar IME composition", () => {
  it("forwards Enter to the grid host when no composition is involved", () => {
    const bar = mountBar();

    press(bar.search);

    expect(bar.keydown).toHaveBeenCalledTimes(1);
  });

  it("swallows the committing Enter that WebKit sends after compositionend", () => {
    const bar = mountBar();
    commitComposition(bar.search);

    // `isComposing` is already false and the keyCode is a plain 13 here: only
    // the grace window tells this Enter apart from a "next match" key.
    press(bar.search, { keyCode: 13 });
    expect(bar.keydown).not.toHaveBeenCalled();

    // The hold lasts for that one key: once it is released, Enter navigates again.
    bar.search.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
    press(bar.search, { keyCode: 13 });
    expect(bar.keydown).toHaveBeenCalledTimes(1);
  });

  it("does not replace the current match on the committing Enter", () => {
    const bar = mountBar();
    commitComposition(bar.replacement);

    press(bar.replacement, { keyCode: 13 });
    expect(bar.replaceCurrent).not.toHaveBeenCalled();

    bar.replacement.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
    press(bar.replacement, { keyCode: 13 });
    expect(bar.replaceCurrent).toHaveBeenCalledTimes(1);
  });

  it("keeps the bar open while Esc dismisses the candidate list mid-composition", () => {
    const bar = mountBar();
    bar.search.dispatchEvent(new Event("compositionstart"));

    press(bar.search, { key: "Escape", isComposing: true });
    expect(bar.close).not.toHaveBeenCalled();

    bar.search.dispatchEvent(new Event("compositionend"));
    press(bar.search, { key: "Escape" });
    expect(bar.close).toHaveBeenCalledTimes(1);
  });
});
