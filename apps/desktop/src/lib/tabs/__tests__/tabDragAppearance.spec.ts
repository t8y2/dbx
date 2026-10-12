// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTabDragAppearance, isTabDragImage } from "../tabDragAppearance";
import { tabDragPreviewHostBounds } from "../tabWindowPreviewHost";

function rect(element: Element, x: number, y: number, width: number, height: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tab drag appearance snapshot", () => {
  it("captures actual geometry, title styles, icons and the original grab point", () => {
    const source = document.createElement("div");
    source.style.cssText = "background-color: rgb(28, 30, 35); color: rgb(220, 230, 240); border-radius: 3px; font-family: monospace;";
    source.innerHTML = '<span data-tab-label-part="icon"><svg viewBox="0 0 24 24"><path d="M2 2L8 8" stroke="red"/></svg></span><span data-tab-label-part="title" style="font-style: italic">*SQL</span>';
    document.body.append(source);
    rect(source, 100, 40, 245, 36);
    rect(source.children[0]!, 108, 51, 14, 14);
    rect(source.querySelector("svg")!, 108, 51, 14, 14);
    rect(source.children[1]!, 126, 49, 150, 18);
    vi.stubGlobal("devicePixelRatio", 1.5);
    const snapshot = captureTabDragAppearance(source, { x: 176, y: 57 });
    expect(snapshot).toMatchObject({ width: 245, height: 36, grabX: 76, grabY: 17, pixelRatio: 1.5 });
    expect(snapshot.style["background-color"]).toBe("rgb(28, 30, 35)");
    expect(snapshot.parts[1]).toMatchObject({ text: "*SQL", style: { left: "26px", "font-style": "italic" } });
    expect(snapshot.parts[0]?.children?.[0]?.image).toMatch(/^data:image\/svg\+xml/);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    const bounds = tabDragPreviewHostBounds(snapshot, { x: 700, y: 300 });
    expect(bounds).toEqual({ x: 574, y: 263, width: 392, height: 78 });
  });

  it("copies only safe vector graphics, not executable SVG or arbitrary HTML", () => {
    const source = document.createElement("div");
    source.innerHTML = '<svg data-tab-label-part="icon" onload="evil()"><path d="M0 0L1 1" onclick="evil()"/></svg>';
    for (const tag of ["script", "foreignObject"]) {
      const unsafe = document.createElementNS("http://www.w3.org/2000/svg", tag);
      unsafe.textContent = "evil()";
      source.children[0]!.append(unsafe);
    }
    document.body.append(source);
    rect(source, 0, 0, 80, 28);
    rect(source.children[0]!, 0, 0, 14, 14);
    const snapshot = captureTabDragAppearance(source, { x: 4, y: 10 });
    const svg = decodeURIComponent(snapshot.parts[0]!.image!.split(",")[1]!);
    expect(svg).toContain("path");
    expect(svg).not.toMatch(/script|foreignObject|onclick|onload|evil/);
    expect(isTabDragImage("javascript:evil()")).toBe(false);
    expect(isTabDragImage("data:text/html,<script>evil()</script>")).toBe(false);
  });

  it("keeps the tab bar background behind translucent inactive tabs", () => {
    const bar = document.createElement("div");
    bar.style.backgroundColor = "rgb(20, 25, 30)";
    const source = document.createElement("div");
    source.style.backgroundColor = "rgba(100, 120, 140, 0.2)";
    bar.append(source);
    document.body.append(bar);
    rect(source, 0, 0, 120, 28);
    const snapshot = captureTabDragAppearance(source, { x: 20, y: 14 });
    expect(snapshot.style["background-color"]).toBe("rgb(20, 25, 30)");
    expect(snapshot.style["background-image"]).toContain("rgba(100, 120, 140, 0.2)");
  });
});
