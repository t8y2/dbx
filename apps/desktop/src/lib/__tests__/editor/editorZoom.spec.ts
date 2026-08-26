import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEditorWheelZoomGestureGuard } from "@/lib/editor/editorZoom";

function wheelEvent(timeStamp: number, modifier = false) {
  return { timeStamp, metaKey: modifier, ctrlKey: false };
}

describe("createEditorWheelZoomGestureGuard", () => {
  it("ignores a modifier pressed during an existing scroll gesture", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(100))).toBe(false);
    expect(guard.accepts(wheelEvent(140, true))).toBe(false);
    expect(guard.accepts(wheelEvent(200, true))).toBe(false);
  });

  it("accepts a wheel gesture that starts with a modifier", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(100, true))).toBe(true);
    expect(guard.accepts(wheelEvent(140, true))).toBe(true);
  });

  it("starts a new zoom gesture after the wheel stream becomes idle", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(100))).toBe(false);
    expect(guard.accepts(wheelEvent(281, true))).toBe(true);
  });

  it("starts a new gesture when browser timestamps reset", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(500))).toBe(false);
    expect(guard.accepts(wheelEvent(10, true))).toBe(true);
  });

  it("can be reset between editor sessions", () => {
    const guard = createEditorWheelZoomGestureGuard();

    expect(guard.accepts(wheelEvent(100))).toBe(false);
    guard.reset();
    expect(guard.accepts(wheelEvent(120, true))).toBe(true);
  });
});

describe("editor wheel zoom integration", () => {
  it.each([
    ["SQL editor", "../../../components/editor/QueryEditor.vue", "wheelZoomGestureGuard"],
    ["cell detail editor", "../../../composables/useCellDetailEditor.ts", "wheelZoomGestureGuard"],
    ["Nacos editor", "../../../components/nacos/NacosAdminConsole.vue", "configEditorWheelZoomGestureGuard"],
  ])("guards %s wheel zoom by gesture origin", (_name, path, guardName) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");

    expect(source).toContain("createEditorWheelZoomGestureGuard");
    expect(source).toContain(`if (!${guardName}.accepts(event)) return false;`);
  });
});
