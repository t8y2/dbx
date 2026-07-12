import { describe, expect, it } from "vitest";
import { startsQueryEditorRectangularSelection } from "@/lib/editor/queryEditorPointerSelection";

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
});
