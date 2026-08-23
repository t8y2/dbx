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
    handle.addEventListener("mousedown", startAiPanelResize);
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 1000 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: -1000 }));
    document.dispatchEvent(new MouseEvent("mouseup"));

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
    handle.addEventListener("mousedown", startAiPanelResize);
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 300 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(aiPanelWidth.value).toBe(600);
    expect(localStorage.getItem("dbx-ai-panel-width")).toBe("600");
  });
});
