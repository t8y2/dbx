// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import SidebarListOptionsIcon from "../SidebarListOptionsIcon.vue";
import SidebarLocateButton from "../SidebarLocateButton.vue";
import SidebarRegexToggleButton from "../SidebarRegexToggleButton.vue";

const mountedApps: App[] = [];

async function mount(component: Component) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(component);
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
  return container;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("sidebar toolbar animations", () => {
  it("restarts the locate pulse on every click without changing the button size", async () => {
    const locate = vi.fn();
    const container = await mount(
      defineComponent({
        setup: () => () => h(SidebarLocateButton, { label: "Locate", onLocate: locate }),
      }),
    );
    const button = container.querySelector("[data-sidebar-locate-button]");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Locate button was not rendered");

    expect(button.className).toContain("h-6 w-6");
    expect(button.querySelector("[data-sidebar-locate-pulse]")).toBeNull();
    button.click();
    await nextTick();
    const firstPulse = button.querySelector("[data-sidebar-locate-pulse]");
    expect(firstPulse).not.toBeNull();
    expect(locate).toHaveBeenCalledTimes(1);

    button.click();
    await nextTick();
    expect(button.querySelector("[data-sidebar-locate-pulse]")).not.toBe(firstPulse);
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it("morphs the list options icon between unfiltered and filtered states", async () => {
    const state = reactive({ filtered: false, open: false });
    const container = await mount(
      defineComponent({
        setup: () => () => h(SidebarListOptionsIcon, { filtered: state.filtered, open: state.open }),
      }),
    );

    const icon = container.querySelector("[data-sidebar-list-options-icon]");
    expect(icon?.querySelector("[data-sidebar-unfiltered-icon]")).not.toBeNull();
    expect(icon?.className).not.toContain("sidebar-list-options-icon--filtered");

    state.filtered = true;
    state.open = true;
    await nextTick();
    expect(icon?.querySelector("[data-sidebar-filtered-icon]")).not.toBeNull();
    expect(icon?.className).toContain("sidebar-list-options-icon--filtered");
    expect(icon?.className).toContain("sidebar-list-options-icon--open");

    state.filtered = false;
    state.open = false;
    await nextTick();
    expect(icon?.querySelector("[data-sidebar-unfiltered-icon]")).not.toBeNull();
    expect(icon?.className).not.toContain("sidebar-list-options-icon--filtered");
  });

  it("replays a bold scale animation in both JavaScript regex states", async () => {
    const state = reactive({ pressed: false, invalid: false });
    const container = await mount(
      defineComponent({
        setup: () => () =>
          h(SidebarRegexToggleButton, {
            label: "JavaScript regex",
            pressed: state.pressed,
            invalid: state.invalid,
            onToggle: () => {
              state.pressed = !state.pressed;
            },
          }),
      }),
    );
    const button = container.querySelector("[data-sidebar-regex-toggle]");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Regex button was not rendered");

    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.querySelector("[data-sidebar-regex-indicator]")).toBeNull();
    const initialGlyph = button.querySelector("[data-sidebar-regex-glyph]");
    button.click();
    await nextTick();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("sidebar-regex-toggle--pressed");
    const pressedGlyph = button.querySelector("[data-sidebar-regex-glyph]");
    expect(pressedGlyph).not.toBe(initialGlyph);
    expect(pressedGlyph?.className).toContain("sidebar-regex-glyph--pressed");
    expect(pressedGlyph?.className).toContain("sidebar-regex-glyph--animated");

    button.click();
    await nextTick();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.className).not.toContain("sidebar-regex-toggle--pressed");
    const releasedGlyph = button.querySelector("[data-sidebar-regex-glyph]");
    expect(releasedGlyph).not.toBe(pressedGlyph);
    expect(releasedGlyph?.className).not.toContain("sidebar-regex-glyph--pressed");
    expect(releasedGlyph?.className).toContain("sidebar-regex-glyph--animated");
  });
});
