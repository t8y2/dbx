import { describe, expect, it } from "vitest";
import { buildOrderedGridRows, type GridNewRowMeta } from "../gridNewRowPlacement";

function entries(sourceIndices: number[], meta: GridNewRowMeta[], count = meta.length) {
  return buildOrderedGridRows(sourceIndices, meta, count);
}

describe("buildOrderedGridRows", () => {
  it("appends unplaced pending rows after the source rows", () => {
    expect(
      entries(
        [0, 1, 2],
        [
          { token: 1, placement: null },
          { token: 2, placement: null },
        ],
      ),
    ).toEqual([
      { kind: "source", sourceIndex: 0 },
      { kind: "source", sourceIndex: 1 },
      { kind: "source", sourceIndex: 2 },
      { kind: "new", newIndex: 0 },
      { kind: "new", newIndex: 1 },
    ]);
  });

  it("places a row below a source row", () => {
    expect(entries([0, 1, 2], [{ token: 1, placement: { anchorId: 1, position: "below" } }])).toEqual([
      { kind: "source", sourceIndex: 0 },
      { kind: "source", sourceIndex: 1 },
      { kind: "new", newIndex: 0 },
      { kind: "source", sourceIndex: 2 },
    ]);
  });

  it("places a row above a source row", () => {
    expect(entries([0, 1, 2], [{ token: 1, placement: { anchorId: 1, position: "above" } }])).toEqual([
      { kind: "source", sourceIndex: 0 },
      { kind: "new", newIndex: 0 },
      { kind: "source", sourceIndex: 1 },
      { kind: "source", sourceIndex: 2 },
    ]);
  });

  it("clusters rows inserted below the same anchor in creation order", () => {
    expect(
      entries(
        [0, 1],
        [
          { token: 1, placement: { anchorId: 0, position: "below" } },
          { token: 2, placement: { anchorId: 0, position: "below" } },
          { token: 3, placement: { anchorId: 0, position: "below" } },
        ],
      ),
    ).toEqual([
      { kind: "source", sourceIndex: 0 },
      { kind: "new", newIndex: 0 },
      { kind: "new", newIndex: 1 },
      { kind: "new", newIndex: 2 },
      { kind: "source", sourceIndex: 1 },
    ]);
  });

  it("clusters rows inserted above the same anchor in creation order", () => {
    expect(
      entries(
        [0, 1],
        [
          { token: 1, placement: { anchorId: 0, position: "above" } },
          { token: 2, placement: { anchorId: 0, position: "above" } },
        ],
      ),
    ).toEqual([
      { kind: "new", newIndex: 0 },
      { kind: "new", newIndex: 1 },
      { kind: "source", sourceIndex: 0 },
      { kind: "source", sourceIndex: 1 },
    ]);
  });

  it("places a row below another pending row", () => {
    expect(
      entries(
        [0, 1],
        [
          { token: 1, placement: { anchorId: 0, position: "below" } },
          { token: 2, placement: { anchorId: -1, position: "below" } },
        ],
      ),
    ).toEqual([
      { kind: "source", sourceIndex: 0 },
      { kind: "new", newIndex: 0 },
      { kind: "new", newIndex: 1 },
      { kind: "source", sourceIndex: 1 },
    ]);
  });

  it("places a row above another pending row", () => {
    expect(
      entries(
        [0, 1],
        [
          { token: 1, placement: null },
          { token: 2, placement: { anchorId: -1, position: "above" } },
        ],
      ),
    ).toEqual([
      { kind: "source", sourceIndex: 0 },
      { kind: "source", sourceIndex: 1 },
      { kind: "new", newIndex: 1 },
      { kind: "new", newIndex: 0 },
    ]);
  });

  it("falls back to the end when the anchor is absent (filtered out or deleted)", () => {
    expect(
      entries(
        [0, 2],
        [
          { token: 1, placement: { anchorId: 1, position: "below" } },
          { token: 2, placement: { anchorId: 5, position: "below" } },
        ],
      ),
    ).toEqual([
      { kind: "source", sourceIndex: 0 },
      { kind: "source", sourceIndex: 2 },
      { kind: "new", newIndex: 0 },
      { kind: "new", newIndex: 1 },
    ]);
  });

  it("tolerates meta shorter than the pending row count (defensive)", () => {
    expect(entries([0], [{ token: 1, placement: null }], 3)).toEqual([
      { kind: "source", sourceIndex: 0 },
      { kind: "new", newIndex: 0 },
      { kind: "new", newIndex: 1 },
      { kind: "new", newIndex: 2 },
    ]);
  });
});
