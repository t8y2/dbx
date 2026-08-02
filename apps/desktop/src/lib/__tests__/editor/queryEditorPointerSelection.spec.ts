import { describe, expect, it } from "vitest";
import { startsQueryEditorRectangularSelection, usesQueryEditorObjectNavigationModifier } from "@/lib/editor/queryEditorPointerSelection";

describe("query editor pointer selection", () => {
  it("starts rectangular selection for Alt+left drag", () => {
    expect(startsQueryEditorRectangularSelection({ altKey: true, button: 0 })).toBe(true);
  });

  it("starts rectangular selection for middle-button drag", () => {
    expect(startsQueryEditorRectangularSelection({ altKey: false, button: 1 })).toBe(true);
  });

  it("leaves ordinary left clicks to the normal cursor handler", () => {
    expect(startsQueryEditorRectangularSelection({ altKey: false, button: 0 })).toBe(false);
  });

  it("uses Cmd or Ctrl without Alt for object navigation", () => {
    expect(usesQueryEditorObjectNavigationModifier({ altKey: false, ctrlKey: false, metaKey: true })).toBe(true);
    expect(usesQueryEditorObjectNavigationModifier({ altKey: false, ctrlKey: true, metaKey: false })).toBe(true);
  });

  it("leaves Alt+Cmd and Alt+Ctrl to multi-cursor selection", () => {
    expect(usesQueryEditorObjectNavigationModifier({ altKey: true, ctrlKey: false, metaKey: true })).toBe(false);
    expect(usesQueryEditorObjectNavigationModifier({ altKey: true, ctrlKey: true, metaKey: false })).toBe(false);
  });

  it("does not treat an unmodified pointer event as object navigation", () => {
    expect(usesQueryEditorObjectNavigationModifier({ altKey: false, ctrlKey: false, metaKey: false })).toBe(false);
  });
});
