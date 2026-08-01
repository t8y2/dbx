// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import LightTooltip from "@/components/ui/LightTooltip.vue";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("LightTooltip scrolling", () => {
  it("stays open for content scrolling and closes for outside scrolling", async () => {
    vi.useFakeTimers();
    const root = defineComponent({
      setup() {
        return () =>
          h(
            LightTooltip,
            { text: "Field details", delay: 0 },
            {
              default: () => h("span", { id: "tooltip-trigger" }, "Field"),
              content: () => h("div", { id: "tooltip-content" }, "Long comment"),
            },
          );
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(root);
    app.mount(container);

    const trigger = container.querySelector<HTMLElement>("#tooltip-trigger");
    expect(trigger).toBeTruthy();
    vi.spyOn(trigger!, "matches").mockImplementation((selector) => selector === ":hover");
    trigger?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await vi.runAllTimersAsync();
    await nextTick();

    const content = document.querySelector("#tooltip-content");
    expect(content).toBeTruthy();
    content?.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(document.querySelector("#tooltip-content")).toBeTruthy();

    document.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(document.querySelector("#tooltip-content")).toBeNull();

    app.unmount();
  });
});
