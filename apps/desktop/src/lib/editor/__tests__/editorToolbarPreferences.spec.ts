import { describe, expect, it } from "vitest";
import { DEFAULT_EDITOR_TOOLBAR_ORDER, editorToolbarActionVisible, moveEditorToolbarAction, normalizeEditorToolbarHiddenActions, normalizeEditorToolbarOrder, resolveEditorToolbarPresentation } from "../editorToolbarPreferences";

describe("editor toolbar preferences", () => {
  it("uses the default order for an empty preference", () => {
    expect(normalizeEditorToolbarOrder(undefined)).toEqual(DEFAULT_EDITOR_TOOLBAR_ORDER);
  });

  it("removes unknown and duplicate ids and appends newly introduced actions", () => {
    const normalized = normalizeEditorToolbarOrder(["save", "execute-all", "unknown", "save"]);

    expect(normalized.slice(0, 2)).toEqual(["save", "execute-all"]);
    expect(normalized).toHaveLength(DEFAULT_EDITOR_TOOLBAR_ORDER.length);
    expect(new Set(normalized)).toEqual(new Set(DEFAULT_EDITOR_TOOLBAR_ORDER));
  });

  it("normalizes hidden actions without allowing the execute action to be hidden", () => {
    expect(normalizeEditorToolbarHiddenActions(["format", "execute", "format", "unknown"])).toEqual(["format"]);
  });

  it("moves an action without changing the action set", () => {
    const moved = moveEditorToolbarAction(DEFAULT_EDITOR_TOOLBAR_ORDER, "save", "up");
    const originalIndex = DEFAULT_EDITOR_TOOLBAR_ORDER.indexOf("save");

    expect(moved[originalIndex - 1]).toBe("save");
    expect(new Set(moved)).toEqual(new Set(DEFAULT_EDITOR_TOOLBAR_ORDER));
  });

  it("resolves order, user visibility, and runtime availability independently", () => {
    const presentation = resolveEditorToolbarPresentation({
      order: ["save", "format"],
      hiddenActions: ["format"],
      availableActions: ["save", "format", "execute"],
    });

    expect(presentation.map((item) => item.id).slice(0, 3)).toEqual(["save", "format", "execute"]);
    expect(presentation.find((item) => item.id === "save")).toMatchObject({ visible: true, available: true });
    expect(presentation.find((item) => item.id === "format")).toMatchObject({ visible: false, available: true });
    expect(editorToolbarActionVisible(presentation, "execute")).toBe(true);
    expect(editorToolbarActionVisible(presentation, "compress")).toBe(false);
  });
});
