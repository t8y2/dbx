import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { selectAllCellDetailText } from "@/lib/dataGrid/cellDetailSelection";

describe("selectAllCellDetailText", () => {
  it("selects the entire cell detail document", () => {
    const state = EditorState.create({ doc: '{"name":"收入合同"}' });
    const dispatch = vi.fn();

    expect(selectAllCellDetailText({ state, dispatch } as any)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ selection: { anchor: 0, head: state.doc.length } });
  });

  it("handles empty cell values", () => {
    const state = EditorState.create({ doc: "" });
    const dispatch = vi.fn();

    selectAllCellDetailText({ state, dispatch } as any);
    expect(dispatch).toHaveBeenCalledWith({ selection: { anchor: 0, head: 0 } });
  });
});
