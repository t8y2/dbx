import { strict as assert } from "node:assert";
import { test } from "vitest";
import { trimmedSelectionHorizontalBounds } from "../../apps/desktop/src/lib/codemirrorTrimmedSelectionLayer.ts";

test("line-break-only selection starts at the content end", () => {
  const bounds = trimmedSelectionHorizontalBounds({
    from: 42,
    to: 42,
    lineFrom: 0,
    lineTo: 42,
    includesLineBreak: true,
    startLeft: 260,
    startRight: 260,
    endLeft: 260,
    endRight: 260,
    lineStartLeft: 80,
    lineEndRight: 260,
    emptySelectionWidth: 7,
  });

  assert.equal(bounds.left, 260);
  assert.equal(bounds.right, 267);
});

test("empty selected line still uses the line start", () => {
  const bounds = trimmedSelectionHorizontalBounds({
    from: 12,
    to: 12,
    lineFrom: 12,
    lineTo: 12,
    includesLineBreak: true,
    startLeft: 80,
    startRight: 80,
    endLeft: 80,
    endRight: 80,
    lineStartLeft: 80,
    lineEndRight: 80,
    emptySelectionWidth: 7,
  });

  assert.equal(bounds.left, 80);
  assert.equal(bounds.right, 87);
});
