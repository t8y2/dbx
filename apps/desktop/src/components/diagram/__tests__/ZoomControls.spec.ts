// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ZoomControls from "@/components/diagram/ZoomControls.vue";

const vueFlowMock = vi.hoisted(() => ({
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  fitView: vi.fn(async () => {}),
}));

vi.mock("@vue-flow/core", () => ({
  useVueFlow: () => vueFlowMock,
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const mountedApps: App[] = [];

function mountZoom(props: { canUndo?: boolean; canRedo?: boolean } = {}) {
  const emits: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(ZoomControls, {
    canUndo: props.canUndo ?? true,
    canRedo: props.canRedo ?? true,
    onUndo: () => emits.push("undo"),
    onRedo: () => emits.push("redo"),
  });
  mountedApps.push(app);
  app.mount(container);
  return { container, emits };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vueFlowMock.zoomIn.mockClear();
  vueFlowMock.zoomOut.mockClear();
  vueFlowMock.fitView.mockClear();
});

describe("ZoomControls", () => {
  it("emits undo/redo and calls vue-flow zoom helpers", async () => {
    const { container, emits } = mountZoom();
    await nextTick();
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(6);

    buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    buttons[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    buttons[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    buttons[4].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    buttons[5].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(emits).toEqual(["undo", "redo"]);
    expect(vueFlowMock.zoomIn).toHaveBeenCalled();
    expect(vueFlowMock.zoomOut).toHaveBeenCalled();
    expect(vueFlowMock.fitView).toHaveBeenCalledTimes(2);
  });

  it("disables undo/redo when props are false", async () => {
    const { container } = mountZoom({ canUndo: false, canRedo: false });
    await nextTick();
    const buttons = container.querySelectorAll("button");
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
  });
});
