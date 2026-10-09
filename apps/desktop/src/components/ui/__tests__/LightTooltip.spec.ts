// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import LightTooltip from "@/components/ui/LightTooltip.vue";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function mountAndHover(props: Record<string, unknown>) {
  const root = defineComponent({
    setup() {
      return () =>
        h(
          LightTooltip,
          { delay: 0, ...props },
          {
            default: () => h("span", { id: "content-class-trigger" }, "pill"),
          },
        );
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(root);
  app.mount(container);

  const trigger = container.querySelector<HTMLElement>("#content-class-trigger");
  expect(trigger).toBeTruthy();
  vi.spyOn(trigger!, "matches").mockImplementation((selector) => selector === ":hover");
  trigger?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  await vi.runAllTimersAsync();
  await nextTick();

  return { app, tooltip: document.querySelector<HTMLElement>("[role=tooltip]") };
}

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

describe("LightTooltip contentClass", () => {
  it("merges contentClass into the teleported tooltip and drops the default max-w-xs", async () => {
    vi.useFakeTimers();
    const { app, tooltip } = await mountAndHover({ text: "Conflict hint", contentClass: "max-w-[320px]" });

    expect(tooltip).toBeTruthy();
    expect(tooltip!.classList.contains("max-w-[320px]")).toBe(true);
    // With both classes present Tailwind v4 emits max-w-[320px] before max-w-xs,
    // so the default must be removed for the caller width to take effect.
    expect(tooltip!.classList.contains("max-w-xs")).toBe(false);

    app.unmount();
  });

  it("keeps the default max-w-xs when no contentClass is passed", async () => {
    vi.useFakeTimers();
    const { app, tooltip } = await mountAndHover({ text: "Plain hint" });

    expect(tooltip).toBeTruthy();
    expect(tooltip!.classList.contains("max-w-xs")).toBe(true);

    app.unmount();
  });
});

describe("LightTooltip nowrap overflow", () => {
  it("wraps a single-line tooltip that is wider than the surface instead of spilling past it", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);

    const { app, tooltip } = await mountAndHover({
      text: "1.2 按月看话单量 (确认没有整月空洞；单条超时时按月拆量重跑)",
      nowrap: true,
    });

    expect(tooltip).toBeTruthy();
    expect(tooltip!.classList.contains("whitespace-nowrap")).toBe(false);
    expect(tooltip!.classList.contains("break-words")).toBe(true);

    app.unmount();
  });

  it("keeps short single-line tooltips on one line", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);

    const { app, tooltip } = await mountAndHover({ text: "复制", nowrap: true });

    expect(tooltip).toBeTruthy();
    expect(tooltip!.classList.contains("whitespace-nowrap")).toBe(true);
    expect(tooltip!.classList.contains("break-words")).toBe(false);

    app.unmount();
  });
});
