// @vitest-environment happy-dom
import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DataGridSearchBar from "../DataGridSearchBar.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
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
