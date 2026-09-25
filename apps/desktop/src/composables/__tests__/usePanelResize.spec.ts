// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelResize } from "@/composables/usePanelResize";

const storage = new Map<string, string>();
const localStorageMock = {
  clear: () => storage.clear(),
  getItem: (key: string) => storage.get(key) ?? null,
  removeItem: (key: string) => storage.delete(key),
  setItem: (key: string, value: string) => storage.set(key, value),
};

function rect(left: number, width: number): DOMRect {
  return {
    bottom: 600,
    height: 600,
    left,
    right: left + width,
    top: 0,
    width,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function pointerEvent(type: string, clientX: number, pointerId = 1): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

describe("usePanelResize", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageMock);
    localStorageMock.clear();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("lets the AI panel consume the available editor width beyond the legacy 800px cap", () => {
    localStorage.setItem("dbx-ai-panel-width", "360");

    const editor = document.createElement("div");
    const panel = document.createElement("div");
    const handle = document.createElement("div");
    panel.append(handle);
    document.body.append(editor, panel);

    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(rect(300, 700));
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(rect(1000, 360));

    const { aiPanelWidth, startAiPanelResize } = usePanelResize();
    handle.addEventListener("pointerdown", startAiPanelResize);
    handle.dispatchEvent(pointerEvent("pointerdown", 1000));
    document.dispatchEvent(pointerEvent("pointermove", -1000));
    document.dispatchEvent(pointerEvent("pointerup", -1000));

    expect(aiPanelWidth.value).toBe(1060);
    expect(localStorage.getItem("dbx-ai-panel-width")).toBe("1060");
  });

  it("resizes from the flex-shrunk width after a wide panel is restored in a narrow window", () => {
    localStorage.setItem("dbx-ai-panel-width", "1060");

    const editor = document.createElement("div");
    const panel = document.createElement("div");
    const handle = document.createElement("div");
    panel.append(handle);
    document.body.append(editor, panel);

    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(rect(300, 0));
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(rect(300, 700));

    const { aiPanelWidth, startAiPanelResize } = usePanelResize();
    handle.addEventListener("pointerdown", startAiPanelResize);
    handle.dispatchEvent(pointerEvent("pointerdown", 300));
    document.dispatchEvent(pointerEvent("pointermove", 400));
    document.dispatchEvent(pointerEvent("pointerup", 400));

    expect(aiPanelWidth.value).toBe(600);
    expect(localStorage.getItem("dbx-ai-panel-width")).toBe("600");
  });

  it("keeps resizable panels wide enough for their toolbar actions", () => {
    const panel = document.createElement("div");
    const handle = document.createElement("div");
    panel.append(handle);
    document.body.append(panel);

    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(rect(0, 260));

    const { sidebarWidth, startSidebarResize } = usePanelResize();
    handle.addEventListener("pointerdown", startSidebarResize);
    handle.dispatchEvent(pointerEvent("pointerdown", 260));
    document.dispatchEvent(pointerEvent("pointermove", 0));

    expect(panel.style.width).toBe("240px");
    document.dispatchEvent(pointerEvent("pointerup", 0));

    expect(sidebarWidth.value).toBe(240);
    expect(localStorage.getItem("dbx-sidebar-width")).toBe("240");
  });

  it("removes the drag overlay when the window loses focus", () => {
    const panel = document.createElement("div");
    const handle = document.createElement("div");
    panel.append(handle);
    document.body.append(panel);

    const { startSidebarResize } = usePanelResize();
    handle.addEventListener("pointerdown", startSidebarResize);
    handle.dispatchEvent(pointerEvent("pointerdown", 260));

    expect(document.body.querySelector('[aria-hidden="true"]')).not.toBeNull();
    window.dispatchEvent(new Event("blur"));
    expect(document.body.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("raises persisted panel widths below the toolbar-safe minimum", () => {
    localStorage.setItem("dbx-sidebar-width", "180");
    localStorage.setItem("dbx-ai-panel-width", "200");

    const { sidebarWidth, aiPanelWidth } = usePanelResize();

    expect(sidebarWidth.value).toBe(240);
    expect(aiPanelWidth.value).toBe(240);
  });

  it("persists the collapsed vertical tab bar state across composable instances", () => {
    const first = usePanelResize();
    expect(first.tabBarCollapsed.value).toBe(false);

    first.setTabBarCollapsed(true);
    expect(first.tabBarCollapsed.value).toBe(true);
    expect(localStorage.getItem("dbx-tab-bar-collapsed")).toBe("true");

    const restored = usePanelResize();
    expect(restored.tabBarCollapsed.value).toBe(true);

    restored.setTabBarCollapsed(false);
    expect(localStorage.getItem("dbx-tab-bar-collapsed")).toBe("false");
  });

  it("updates the outer workspace tab rail width and flex while dragging (issue #9977)", () => {
    localStorage.setItem("dbx-tab-bar-width", "240");

    const rail = document.createElement("div");
    rail.setAttribute("data-workspace-tab-navigation", "");
    rail.style.width = "240px";
    rail.style.flex = "0 0 240px";
    const target = document.createElement("div");
    const tabBar = document.createElement("div");
    tabBar.className = "app-tab-bar";
    const handle = document.createElement("div");
    tabBar.append(handle);
    target.append(tabBar);
    rail.append(target);
    document.body.append(rail);

    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(rect(0, 240));

    const { tabBarWidth, startLeftTabBarResize } = usePanelResize();
    handle.addEventListener("pointerdown", startLeftTabBarResize);
    handle.dispatchEvent(pointerEvent("pointerdown", 240));
    document.dispatchEvent(pointerEvent("pointermove", 320));

    expect(rail.style.width).toBe("320px");
    expect(rail.style.flex).toBe("0 0 320px");
    expect(tabBar.style.width).toBe("");

    document.dispatchEvent(pointerEvent("pointerup", 320));
    expect(tabBarWidth.value).toBe(320);
    expect(localStorage.getItem("dbx-tab-bar-width")).toBe("320");
  });

  it("shrinks a right-side tab rail toward the left edge while dragging", () => {
    localStorage.setItem("dbx-tab-bar-width", "300");

    const rail = document.createElement("div");
    rail.setAttribute("data-special-page-navigation", "");
    const tabBar = document.createElement("div");
    const handle = document.createElement("div");
    tabBar.append(handle);
    rail.append(tabBar);
    document.body.append(rail);

    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(rect(900, 300));

    const { tabBarWidth, startRightTabBarResize } = usePanelResize();
    handle.addEventListener("pointerdown", startRightTabBarResize);
    handle.dispatchEvent(pointerEvent("pointerdown", 900));
    document.dispatchEvent(pointerEvent("pointermove", 960));

    expect(rail.style.width).toBe("240px");
    expect(rail.style.flex).toBe("0 0 240px");

    document.dispatchEvent(pointerEvent("pointerup", 960));
    expect(tabBarWidth.value).toBe(240);
  });
});
