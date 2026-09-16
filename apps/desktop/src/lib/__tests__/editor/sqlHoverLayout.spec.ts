// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { constrainSqlHoverLayout, sqlHoverScrollbarMetrics } from "@/lib/editor/sqlHoverLayout";

describe("constrainSqlHoverLayout", () => {
  it("caps table structure hovers and scrolls oversized DDL inside the content area", () => {
    const root = document.createElement("div");
    const content = document.createElement("div");

    constrainSqlHoverLayout(root, content);

    expect(root.dataset.sqlStructureHover).toBe("true");
    expect(root.style.width).toBe("80vw");
    expect(root.style.maxWidth).toBe("900px");
    expect(root.style.maxHeight).toBe("calc(50vh - 12px)");
    expect(root.style.overflow).toBe("hidden");
    expect(content.dataset.sqlStructureHoverContent).toBe("true");
    expect(content.style.flex).toBe("0 1 auto");
    expect(content.style.maxHeight).toBe("480px");
    expect(content.style.maxWidth).toBe("100%");
    expect(content.style.overflowX).toBe("hidden");
    expect(content.style.overflowY).toBe("auto");
    expect(content.style.overscrollBehavior).toBe("contain");
    expect(content.style.scrollbarGutter).toBe("stable");
    expect(root.querySelector('[data-sql-structure-hover-scrollbar="true"]')).not.toBeNull();
    expect(root.querySelector('[data-sql-structure-hover-scrollbar-thumb="true"]')).not.toBeNull();
  });

  it("maps content scroll position to a proportional custom scrollbar thumb", () => {
    expect(sqlHoverScrollbarMetrics(600, 1200, 300, 600)).toEqual({
      maxScroll: 600,
      maxThumbLeft: 300,
      thumbLeft: 150,
      thumbWidth: 300,
    });

    expect(sqlHoverScrollbarMetrics(600, 6000, 5400, 600)).toEqual({
      maxScroll: 5400,
      maxThumbLeft: 540,
      thumbLeft: 540,
      thumbWidth: 60,
    });
  });

  it("keeps horizontal trackpad scrolling while the native scrollbar is hidden", () => {
    const root = document.createElement("div");
    const content = document.createElement("div");
    Object.defineProperty(content, "clientWidth", { configurable: true, value: 600 });
    Object.defineProperty(content, "scrollWidth", { configurable: true, value: 1200 });
    constrainSqlHoverLayout(root, content);

    const wheelEvent = new WheelEvent("wheel", { cancelable: true, deltaX: 120 });
    content.dispatchEvent(wheelEvent);

    expect(content.scrollLeft).toBe(120);
    expect(wheelEvent.defaultPrevented).toBe(true);
  });

  it("starts the scrollbar on mount and stops responding after destroy", () => {
    const root = document.createElement("div");
    const content = document.createElement("div");
    Object.defineProperty(content, "clientWidth", { configurable: true, value: 600 });
    Object.defineProperty(content, "scrollWidth", { configurable: true, value: 2400 });
    const controller = constrainSqlHoverLayout(root, content);
    const track = root.querySelector<HTMLElement>('[data-sql-structure-hover-scrollbar="true"]')!;

    // 挂载前未跑过 update，轨道仍隐藏
    expect(track.hidden).toBe(true);
    controller.mount();
    expect(track.hidden).toBe(false);

    const before = content.scrollLeft;
    content.dispatchEvent(new WheelEvent("wheel", { cancelable: true, deltaX: 120 }));
    expect(content.scrollLeft).toBe(before + 120);

    controller.destroy();
    const afterDestroy = content.scrollLeft;
    content.dispatchEvent(new WheelEvent("wheel", { cancelable: true, deltaX: 120 }));
    expect(content.scrollLeft).toBe(afterDestroy);
  });
});
