// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { SearchableSelect } from "..";

const mountedApps: App[] = [];

function mountSelect(props: Record<string, unknown> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const emitted = { modelValue: [] as unknown[], open: [] as unknown[] };
  const app = createApp(SearchableSelect, {
    modelValue: "Point",
    options: ["Point", "LineString"],
    placeholder: "type",
    searchPlaceholder: "search",
    emptyText: "empty",
    ...props,
    "onUpdate:modelValue": (value: unknown) => emitted.modelValue.push(value),
    "onUpdate:open": (value: unknown) => emitted.open.push(value),
  });
  mountedApps.push(app);
  app.mount(root);
  return { root, emitted };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("SearchableSelect trigger", () => {
  it("does not traverse option values while the popover is closed", () => {
    let optionReads = 0;
    const options = ["Point", "LineString"];
    Object.defineProperty(options, "1", {
      configurable: true,
      enumerable: true,
      get() {
        optionReads += 1;
        return "LineString";
      },
    });

    mountSelect({ options });

    expect(optionReads).toBe(0);
  });

  it("renders the trigger button itself as the layout participant", () => {
    const { root } = mountSelect({ triggerClass: "min-w-0 flex-1" });

    const trigger = root.querySelector("button");

    // No wrapper element may sit between the parent layout context and the
    // trigger: triggerClass utilities (flex-1 / min-w-0 / max-w-*) must stay
    // effective on the element the consumer lays out.
    expect(trigger).not.toBeNull();
    expect(root.firstElementChild).toBe(trigger);
    expect(trigger?.className).toContain("flex-1");
    expect(trigger?.className).toContain("min-w-0");
  });

  it("clears through the overlay without toggling the popover open", async () => {
    const { root, emitted } = mountSelect({ clearable: true });

    const clear = root.querySelector<HTMLElement>('[title="common.clear"]');
    expect(clear).not.toBeNull();
    expect(clear?.getAttribute("aria-label")).toBe("common.clear");

    clear?.click();
    await nextTick();

    expect(emitted.modelValue).toEqual([""]);
    expect(emitted.open).toEqual([]);
  });

  it("keeps the chevron space reserved while the clear overlay is shown", () => {
    const { root } = mountSelect({ clearable: true });

    expect(root.querySelector("button .invisible")).not.toBeNull();
  });

  it("opens popover and pre-fills search text when a printable character is pressed on trigger button", async () => {
    const { root, emitted } = mountSelect({
      options: ["int", "varchar", "bigint"],
      modelValue: "int",
    });

    const trigger = root.querySelector("button")!;
    const event = new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await nextTick();
    expect(emitted.open).toEqual([true]);

    const input = document.body.querySelector<HTMLInputElement>("input")!;
    expect(input).not.toBeNull();
    expect(input.value).toBe("v");
  });

  it("opens popover when ArrowDown or ArrowUp is pressed on trigger button", async () => {
    const { root, emitted } = mountSelect();

    const trigger = root.querySelector("button")!;
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await nextTick();
    expect(emitted.open).toEqual([true]);
  });

  it("clears value when Backspace or Delete is pressed on clearable trigger button", async () => {
    const { root, emitted } = mountSelect({ clearable: true, modelValue: "Point" });

    const trigger = root.querySelector("button")!;
    const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(emitted.modelValue).toEqual([""]);
    expect(emitted.open).toEqual([]);
  });

  it("navigates and selects options with ArrowDown and Enter in search input", async () => {
    const { root, emitted } = mountSelect({
      options: ["varchar", "varbinary", "bigint"],
      modelValue: "",
    });

    const trigger = root.querySelector("button")!;
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true }));

    await nextTick();
    const input = document.body.querySelector<HTMLInputElement>("input")!;
    expect(input).not.toBeNull();

    // ArrowDown moves highlight to "varbinary"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await nextTick();

    // Enter selects "varbinary"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();

    expect(emitted.modelValue).toContain("varbinary");
    expect(emitted.open).toContain(false);
  });

  it("selects highlighted option and closes when Tab is pressed in search input", async () => {
    const { root, emitted } = mountSelect({
      options: ["varchar", "varbinary", "bigint"],
      modelValue: "",
    });

    const trigger = root.querySelector("button")!;
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true }));

    await nextTick();
    const input = document.body.querySelector<HTMLInputElement>("input")!;
    expect(input).not.toBeNull();

    // Tab selects first match ("varchar") and closes
    const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input.dispatchEvent(tabEvent);
    await nextTick();

    expect(tabEvent.defaultPrevented).toBe(true);
    expect(emitted.modelValue).toContain("varchar");
    expect(emitted.open).toContain(false);
  });

  it("does not intercept Tab while an IME composition is active in search input", async () => {
    const { root, emitted } = mountSelect({
      options: ["varchar", "bigint"],
      modelValue: "",
    });

    const trigger = root.querySelector("button")!;
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true }));

    await nextTick();
    const input = document.body.querySelector<HTMLInputElement>("input")!;
    expect(input).not.toBeNull();

    const composingTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    Object.defineProperty(composingTab, "isComposing", { value: true });
    input.dispatchEvent(composingTab);
    await nextTick();

    // Composition must survive: no selection, no close, focus stays in the search input.
    expect(emitted.modelValue).toEqual([]);
    expect(emitted.open).not.toContain(false);
    expect(document.activeElement).toBe(input);
  });

  it("marks list option buttons with tabindex=-1 to prevent tab trapping", async () => {
    const { root } = mountSelect({
      options: ["int", "varchar"],
    });

    const trigger = root.querySelector("button")!;
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await nextTick();

    const optionButtons = document.body.querySelectorAll(".dbx-searchable-select-list button");
    expect(optionButtons.length).toBeGreaterThan(0);
    for (const btn of optionButtons) {
      expect(btn.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("does not open popover on keydown when trigger is disabled", async () => {
    const { root, emitted } = mountSelect({ disabled: true });

    const trigger = root.querySelector("button")!;
    const event = new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);

    await nextTick();
    expect(event.defaultPrevented).toBe(false);
    expect(emitted.open).toEqual([]);
  });

  it("accumulates rapid keystrokes on the trigger before input receives focus", async () => {
    const { root } = mountSelect({
      options: ["int", "varchar"],
      modelValue: "",
    });

    const trigger = root.querySelector("button")!;
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));

    await nextTick();
    const input = document.body.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("va");
  });

  it("focuses adjacent element when Tab or Shift+Tab is pressed in search input", async () => {
    const root = document.createElement("div");
    const prevInput = document.createElement("input");
    prevInput.id = "prev-input";
    const nextInput = document.createElement("input");
    nextInput.id = "next-input";
    root.append(prevInput);
    const selectContainer = document.createElement("div");
    root.append(selectContainer);
    root.append(nextInput);
    document.body.append(root);

    const emitted = { modelValue: [] as unknown[], open: [] as unknown[] };
    const app = createApp(SearchableSelect, {
      modelValue: "",
      options: ["int", "varchar"],
      placeholder: "type",
      searchPlaceholder: "search",
      emptyText: "empty",
      "onUpdate:modelValue": (v: unknown) => emitted.modelValue.push(v),
      "onUpdate:open": (v: unknown) => emitted.open.push(v),
    });
    mountedApps.push(app);
    app.mount(selectContainer);

    const trigger = selectContainer.querySelector("button")!;
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true }));
    await nextTick();

    const searchInput = document.body.querySelector<HTMLInputElement>("input[data-slot='input']")!;
    expect(searchInput).not.toBeNull();

    const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    searchInput.dispatchEvent(tabEvent);
    await nextTick();
    await nextTick();

    expect(tabEvent.defaultPrevented).toBe(true);
    expect(emitted.modelValue).toEqual(["int"]);
    expect(document.activeElement).toBe(nextInput);
  });
});
