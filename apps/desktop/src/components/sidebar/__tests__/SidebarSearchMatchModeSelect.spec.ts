// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import SidebarSearchMatchModeSelect from "../SidebarSearchMatchModeSelect.vue";
import type { SidebarSearchMatchMode } from "@/lib/sidebar/sidebarSearch";

const messages = {
  sidebar: {
    searchMatchMode: "Match mode",
    searchMatchModeFuzzy: "Fuzzy",
    searchMatchModeContains: "Contains",
    searchMatchModeEdges: "Edges",
    searchMatchModeTooltip: "How sidebar search matches names.",
  },
};

const mountedApps: App[] = [];

async function mount(initial: SidebarSearchMatchMode, state?: { disabled: boolean; mode: SidebarSearchMatchMode }) {
  const container = document.createElement("div");
  document.body.append(container);
  const model = reactive({ value: initial, disabled: state?.disabled ?? false });
  const onUpdate = vi.fn();
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(SidebarSearchMatchModeSelect, {
          modelValue: model.value,
          disabled: model.disabled,
          "onUpdate:modelValue": (mode: SidebarSearchMatchMode) => {
            model.value = mode;
            onUpdate(mode);
          },
        }),
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: messages } }));
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
  if (state) state.mode = model.value;
  return { container, onUpdate, model };
}

function trigger(container: HTMLElement): HTMLButtonElement {
  const element = container.querySelector("[data-sidebar-search-match-mode-trigger]");
  if (!(element instanceof HTMLButtonElement)) throw new Error("Match mode trigger was not rendered");
  return element;
}

function menuItems(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitemradio"]')];
}

function checkedItemLabel(): string | undefined {
  return menuItems()
    .find((item) => item.getAttribute("aria-checked") === "true")
    ?.textContent?.trim();
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("SidebarSearchMatchModeSelect", () => {
  it("renders the active mode on the trigger with menu semantics", async () => {
    const { container } = await mount("fuzzy");
    const button = trigger(container);

    expect(button.getAttribute("data-sidebar-search-match-mode")).toBe("fuzzy");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Match mode: Fuzzy");
    expect(button.disabled).toBe(false);
    expect(container.querySelector("[data-sidebar-search-match-mode-trigger] .lucide-wand-2")).not.toBeNull();
  });

  it("lists all three modes and checks the active one", async () => {
    const { container } = await mount("contains");
    trigger(container).click();
    await nextTick();

    expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual(["Fuzzy", "Contains", "Edges"]);
    expect(checkedItemLabel()).toBe("Contains");
    // Radio semantics: the single-select group reports its state to assistive tech.
    expect(menuItems().map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("emits the picked mode once and reflects it back on the trigger", async () => {
    const { container, onUpdate } = await mount("fuzzy");
    trigger(container).click();
    await nextTick();

    const edges = menuItems().find((item) => item.textContent?.trim() === "Edges");
    expect(edges).toBeTruthy();
    edges!.click();
    await nextTick();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("edges");
    expect(trigger(container).getAttribute("data-sidebar-search-match-mode")).toBe("edges");
    expect(trigger(container).getAttribute("aria-label")).toBe("Match mode: Edges");
    // Single-select dropdown closes after a pick.
    expect(menuItems()).toHaveLength(0);
  });

  it("moves focus between the radio options with the arrow keys", async () => {
    const { container } = await mount("fuzzy");
    trigger(container).click();
    await nextTick();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(menuItems()[0]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(menuItems()[1]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(menuItems()).toHaveLength(0);
  });

  it("disables the trigger and stays closed while regex mode owns the search", async () => {
    const { container } = await mount("fuzzy", { disabled: true, mode: "fuzzy" });
    const button = trigger(container);

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Match mode: Fuzzy");
    button.click();
    await nextTick();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(menuItems()).toHaveLength(0);
    expect(container.querySelector("[data-sidebar-search-match-mode-trigger]")?.className).toContain("disabled:opacity-50");
  });
});
