// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import TabDragPreviewChip from "../TabDragPreviewChip.vue";
import TabLabelContent from "../TabLabelContent.vue";
import type { TabDragAppearance } from "@/lib/tabs/tabDragAppearance";

describe("TabDragPreviewChip", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it("preserves source dimensions, colors, title and static icons without controls", () => {
    const host = document.createElement("div");
    const title = "查询 <users> & 订单";
    const appearance: TabDragAppearance = {
      width: 237,
      height: 36,
      grabX: 92,
      grabY: 18,
      pixelRatio: 1.5,
      style: { "background-color": "rgb(32, 34, 40)", color: "rgb(230, 230, 230)", "border-radius": "2px" },
      parts: [
        { style: { left: "4px", top: "8px", width: "14px", height: "14px" }, image: "data:image/svg+xml,%3Csvg%2F%3E" },
        { style: { left: "20px", width: "160px", "font-style": "italic" }, text: `*${title}` },
        { style: { left: "200px" }, text: "×" },
      ],
    };
    const app = createApp(TabDragPreviewChip, { appearance });
    app.mount(host);
    cleanup = () => app.unmount();
    const preview = host.querySelector<HTMLElement>(".tab-drag-preview")!;
    expect(preview.textContent).toBe(`*${title}×`);
    expect(preview.style.width).toBe("237px");
    expect(preview.style.height).toBe("36px");
    expect(preview.style.backgroundColor).toBe("rgb(32, 34, 40)");
    expect(preview.style.borderRadius).toBe("2px");
    expect(host.querySelectorAll("img")).toHaveLength(1);
    expect(host.querySelector("button, input, users")).toBeNull();
    expect(preview.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps close and pin actions in the tab bar's interactive presentation", () => {
    const host = document.createElement("div");
    const close = vi.fn();
    const unpin = vi.fn();
    const app = createApp(TabLabelContent, { title: "SQL", dirty: true, pinned: true, closeLabel: "关闭", unpinLabel: "取消固定", onClose: close, onUnpin: unpin });
    app.mount(host);
    cleanup = () => app.unmount();
    expect(host.querySelector(".dirty-tab-marker")?.textContent).toBe("*");
    host.querySelector<HTMLButtonElement>('[data-tab-label-part="pin"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-tab-label-part="close"]')!.click();
    expect(unpin).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps collapsed side tabs icon-only with their dirty marker", () => {
    const host = document.createElement("div");
    const app = createApp(TabLabelContent, { title: "SQL", dirty: true, collapsed: true, pinned: true });
    app.mount(host);
    cleanup = () => app.unmount();
    expect(host.querySelector(".compact-dirty-tab-marker")).not.toBeNull();
    expect(host.querySelector("button, .truncate")).toBeNull();
  });
});
