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

describe("LightTooltip positioning with clipping ancestors", () => {
  it("anchors right-side tooltip to the clipping container boundary when trigger is wider (#13717)", async () => {
    vi.useFakeTimers();

    const root = defineComponent({
      setup() {
        return () =>
          h(
            "div",
            { id: "scroll-container", style: { overflowX: "auto" } },
            h(
              LightTooltip,
              { text: "Connection Details", side: "right", sideOffset: 8, delay: 0 },
              {
                default: () => h("div", { id: "tree-row" }, "Wide tree row"),
              },
            ),
          );
      },
    });

    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(root);
    app.mount(container);

    const scroller = container.querySelector<HTMLElement>("#scroll-container");
    const row = container.querySelector<HTMLElement>("#tree-row");
    expect(scroller).toBeTruthy();
    expect(row).toBeTruthy();

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "scroll-container") {
        return { left: 0, right: 260, top: 50, bottom: 600, width: 260, height: 550 } as DOMRect;
      }
      if (this.id === "tree-row") {
        return { left: 0, right: 600, top: 100, bottom: 128, width: 600, height: 28 } as DOMRect;
      }
      if (this.getAttribute("role") === "tooltip") {
        return { left: 268, right: 388, top: 100, bottom: 128, width: 120, height: 28 } as DOMRect;
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
    });

    vi.spyOn(row!, "matches").mockImplementation((selector) => selector === ":hover");
    row?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await vi.runAllTimersAsync();
    await nextTick();

    const tooltip = document.querySelector<HTMLElement>("[role=tooltip]");
    expect(tooltip).toBeTruthy();
    // Clipped right edge is 260, offset is 8 -> left: 268px (NOT 608px)
    expect(tooltip!.style.left).toBe("268px");
    expect(tooltip!.style.top).toBe("114px");

    app.unmount();
  });

  it("centers top-side tooltip over visible trigger width inside clipping container", async () => {
    vi.useFakeTimers();

    const root = defineComponent({
      setup() {
        return () =>
          h(
            "div",
            { id: "scroll-container", style: { overflowX: "auto" } },
            h(
              LightTooltip,
              { text: "Table Header", side: "top", sideOffset: 8, delay: 0 },
              {
                default: () => h("div", { id: "tree-row" }, "Wide header"),
              },
            ),
          );
      },
    });

    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(root);
    app.mount(container);

    const scroller = container.querySelector<HTMLElement>("#scroll-container");
    const row = container.querySelector<HTMLElement>("#tree-row");
    expect(scroller).toBeTruthy();
    expect(row).toBeTruthy();

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "scroll-container") {
        return { left: 0, right: 260, top: 50, bottom: 600, width: 260, height: 550 } as DOMRect;
      }
      if (this.id === "tree-row") {
        return { left: 0, right: 600, top: 100, bottom: 128, width: 600, height: 28 } as DOMRect;
      }
      if (this.getAttribute("role") === "tooltip") {
        return { left: 100, right: 160, top: 64, bottom: 92, width: 60, height: 28 } as DOMRect;
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
    });

    vi.spyOn(row!, "matches").mockImplementation((selector) => selector === ":hover");
    row?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await vi.runAllTimersAsync();
    await nextTick();

    const tooltip = document.querySelector<HTMLElement>("[role=tooltip]");
    expect(tooltip).toBeTruthy();
    // Visible trigger rect has left: 0, right: 260 -> center is 130 (NOT 300)
    // top: 100 - 8 = 92px
    expect(tooltip!.style.left).toBe("130px");
    expect(tooltip!.style.top).toBe("92px");

    app.unmount();
  });
});
